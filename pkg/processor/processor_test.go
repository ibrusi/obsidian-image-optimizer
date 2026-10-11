package processor

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/downloader"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/report"
)

// shrinkingRunner simulates encoders that always produce a tiny output, so
// processor tests are deterministic and need no external tools.
type shrinkingRunner struct{}

func (shrinkingRunner) Run(_ context.Context, _ string, args ...string) error {
	dst := strings.TrimPrefix(args[len(args)-1], "file:")
	for i, a := range args {
		if a == "-o" && i+1 < len(args) {
			dst = args[i+1]
		}
	}
	return os.WriteFile(dst, []byte("tiny"), 0o644)
}

var fakeTools = optimizer.Toolchain{Cwebp: "cwebp", Ffmpeg: "ffmpeg", Gifsicle: "gifsicle", Gif2webp: "gif2webp"}

type harness struct {
	t     *testing.T
	vault string
	cfg   *config.Config
	out   *bytes.Buffer
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	vault := t.TempDir()
	cfg := config.DefaultConfig()
	cfg.VaultPath = vault
	cfg.AllowPrivateHosts = true // test servers listen on 127.0.0.1
	return &harness{t: t, vault: vault, cfg: cfg, out: &bytes.Buffer{}}
}

func (h *harness) path(rel string) string {
	return filepath.Join(h.vault, filepath.FromSlash(rel))
}

func (h *harness) write(rel string, data []byte) {
	h.t.Helper()
	p := h.path(rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(p, data, 0o644); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) read(rel string) string {
	h.t.Helper()
	data, err := os.ReadFile(h.path(rel))
	if err != nil {
		h.t.Fatal(err)
	}
	return string(data)
}

func (h *harness) exists(rel string) bool {
	_, err := os.Lstat(h.path(rel))
	return err == nil
}

func (h *harness) run() *Processor {
	h.t.Helper()
	if err := h.cfg.Validate(); err != nil {
		h.t.Fatalf("invalid test config: %v", err)
	}
	dl := downloader.New(downloader.Options{
		Timeout:           5 * time.Second,
		MaxBytes:          h.cfg.MaxDownloadBytes(),
		AllowPrivateHosts: h.cfg.AllowPrivateHosts,
	})
	opt := optimizer.New(fakeTools, shrinkingRunner{}, optimizer.OptionsFromConfig(h.cfg))
	p := New(h.cfg, report.NewText(h.out, true), dl, opt)
	if err := p.Run(context.Background()); err != nil {
		h.t.Fatalf("run failed: %v\n%s", err, h.out)
	}
	return p
}

// tree lists all files below the vault with their sizes.
func (h *harness) tree() []string {
	h.t.Helper()
	var files []string
	err := filepath.WalkDir(h.vault, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, _ := d.Info()
		rel, _ := filepath.Rel(h.vault, path)
		files = append(files, filepath.ToSlash(rel)+":"+strconv.FormatInt(info.Size(), 10))
		return nil
	})
	if err != nil {
		h.t.Fatal(err)
	}
	sort.Strings(files)
	return files
}

func (h *harness) assertNoTempFiles() {
	h.t.Helper()
	for _, f := range h.tree() {
		if strings.Contains(f, ".imgopt-") {
			h.t.Errorf("temp file left behind: %s", f)
		}
	}
}

func pngBytes(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 3), G: uint8(y * 5), B: uint8(x ^ y), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// imageServer serves a PNG for /*.png paths, HTML for /html and counts requests.
func imageServer(t *testing.T, onRequest func(r *http.Request)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	img := pngBytes(t, 64)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if onRequest != nil {
			onRequest(r)
		}
		if r.URL.Path == "/html" {
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<html>hotlinking denied</html>"))
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Write(img)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestRemoteImagesAreDownloadedConvertedAndLinked(t *testing.T) {
	h := newHarness(t)
	srv, hits := imageServer(t, nil)
	h.write("My Note.md", []byte("# Note\n"+
		"![Diagram]("+srv.URL+"/diagram.png \"Title\")\n"+
		"<img src=\""+srv.URL+"/shot.png\" alt=\"Shot\">\n"+
		"Again: ![Diagram]("+srv.URL+"/diagram.png)\n"))
	h.write("sub/Other.md", []byte("![x]("+srv.URL+"/diagram.png)\n"))

	p := h.run()

	note := h.read("My Note.md")
	if strings.Contains(note, srv.URL) {
		t.Fatalf("remote URL left in note:\n%s", note)
	}
	for _, want := range []string{"![Diagram](attachments/diagram_", ".webp \"Title\")", "<img src=\"attachments/shot_", "alt=\"Shot\">"} {
		if !strings.Contains(note, want) {
			t.Errorf("note misses %q:\n%s", want, note)
		}
	}
	if other := h.read("sub/Other.md"); !strings.Contains(other, "![x](attachments/diagram_") {
		t.Errorf("note in subfolder must use its own attachments folder:\n%s", other)
	}

	stats := p.Stats()
	if stats.FilesModified != 2 || stats.ImagesCompressed != 3 || stats.Errors != 0 {
		t.Errorf("unexpected stats %+v", stats)
	}
	// The same URL in one folder is downloaded once.
	if hits.Load() != 3 {
		t.Errorf("expected 3 downloads, got %d", hits.Load())
	}
	backups, _ := os.ReadDir(h.path("attachments/.originals_backup"))
	if len(backups) != 2 {
		t.Errorf("expected 2 backed up originals, got %d", len(backups))
	}
	h.assertNoTempFiles()
}

func TestDryRunDoesNotTouchDiskOrNetwork(t *testing.T) {
	h := newHarness(t)
	srv, hits := imageServer(t, nil)
	h.write("note.md", []byte("![r]("+srv.URL+"/a.png)\n![l](pic.png)\n![[pic.jpg]]\n"))
	h.write("pic.png", pngBytes(t, 32))
	h.write("pic.jpg", append([]byte("\xFF\xD8\xFF"), make([]byte, 500)...))
	h.cfg.DryRun = true
	h.cfg.OptimizeLocal = true

	before := h.tree()
	p := h.run()

	if after := h.tree(); strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Fatalf("dry run changed files:\nbefore %v\nafter  %v", before, after)
	}
	if hits.Load() != 0 {
		t.Errorf("dry run performed %d HTTP requests", hits.Load())
	}
	if s := p.Stats(); s.PlannedDownloads != 1 || s.PlannedLocal != 2 {
		t.Errorf("unexpected plan %+v", s)
	}
}

func TestNonImageResponseKeepsRemoteLink(t *testing.T) {
	h := newHarness(t)
	srv, _ := imageServer(t, nil)
	content := "![h](" + srv.URL + "/html)\n"
	h.write("note.md", []byte(content))

	p := h.run()

	if got := h.read("note.md"); got != content {
		t.Errorf("note must be unchanged, got:\n%s", got)
	}
	if p.Stats().Errors != 1 {
		t.Errorf("expected 1 error, got %+v", p.Stats())
	}
	entries, _ := os.ReadDir(h.path("attachments"))
	if len(entries) != 0 {
		t.Errorf("no files may be left behind, found %d", len(entries))
	}
}

func TestPrivateHostsBlockedByDefault(t *testing.T) {
	h := newHarness(t)
	h.cfg.AllowPrivateHosts = false
	srv, hits := imageServer(t, nil)
	content := "![r](" + srv.URL + "/a.png)\n"
	h.write("note.md", []byte(content))

	p := h.run()

	if hits.Load() != 0 {
		t.Error("request to a loopback address must not be made")
	}
	if h.read("note.md") != content || p.Stats().Errors != 1 {
		t.Errorf("expected unchanged note and one error, stats %+v", p.Stats())
	}
}

func TestEditsDuringDownloadArePreserved(t *testing.T) {
	h := newHarness(t)
	notePath := h.path("note.md")
	srv, _ := imageServer(t, func(*http.Request) {
		// The user keeps typing while the image downloads.
		f, err := os.OpenFile(notePath, os.O_APPEND|os.O_WRONLY, 0)
		if err == nil {
			f.WriteString("typed during download\n")
			f.Close()
		}
	})
	h.write("note.md", []byte("![r]("+srv.URL+"/a.png)\n"))

	h.run()

	got := h.read("note.md")
	if !strings.Contains(got, "typed during download") {
		t.Errorf("user edit was lost:\n%s", got)
	}
	if strings.Contains(got, srv.URL) {
		t.Errorf("link was not rewritten:\n%s", got)
	}
}

func TestLocalDoesNotClobberExistingFiles(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.write("note.md", []byte("![a](pic.png)\n"))
	h.write("pic.png", pngBytes(t, 32))
	h.write("pic.webp", []byte("user-owned webp"))

	h.run()

	if h.read("pic.webp") != "user-owned webp" {
		t.Fatal("existing pic.webp was overwritten")
	}
	if got := h.read("note.md"); got != "![a](pic-1.webp)\n" {
		t.Errorf("unexpected note: %q", got)
	}
	if h.exists("pic.png") || !h.exists(".originals_backup/pic.png") {
		t.Error("original must be moved to the backup folder")
	}
	h.assertNoTempFiles()
}

func TestLocalSameBaseNameDifferentExtensions(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.write("b.md", []byte("![a](x.jpg)\n"))
	h.write("c.md", []byte("![b](x.png)\n"))
	h.write("x.jpg", append([]byte("\xFF\xD8\xFF"), make([]byte, 500)...))
	h.write("x.png", pngBytes(t, 32))

	h.run()

	b, c := h.read("b.md"), h.read("c.md")
	if b == c {
		t.Fatalf("both notes point to the same file: %q", b)
	}
	if b != "![a](x.webp)\n" || c != "![b](x-1.webp)\n" {
		t.Errorf("unexpected links: %q, %q", b, c)
	}
}

func TestSharedLocalImageRewrittenEverywhere(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.cfg.FilePath = h.path("notes/a.md") // only one note is targeted
	h.write("notes/a.md", []byte("![s](../img/shared.png)\n"))
	h.write("notes/b.md", []byte("See ![[shared.png|200]] and ![x](/img/shared.png)\n"))
	h.write("img/shared.png", pngBytes(t, 32))

	p := h.run()

	if got := h.read("notes/a.md"); got != "![s](../img/shared.webp)\n" {
		t.Errorf("a.md: %q", got)
	}
	if got := h.read("notes/b.md"); got != "See ![[img/shared.webp|200]] and ![x](/img/shared.webp)\n" {
		t.Errorf("b.md: %q", got)
	}
	if h.exists("img/shared.png") || !h.exists("img/.originals_backup/shared.png") {
		t.Error("original must be retired once every note was rewritten")
	}
	if p.Stats().FilesModified != 2 {
		t.Errorf("expected 2 modified files, got %+v", p.Stats())
	}
}

func TestOriginalKeptWhileStillMentioned(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.write("a.md", []byte("![p](photo.png)\n"))
	h.write("props.md", []byte("---\ncover: \"[[photo.png]]\"\n---\n"))
	h.write("board.canvas", []byte(`{"nodes":[{"type":"file","file":"photo.png"}]}`))
	h.write("photo.png", pngBytes(t, 32))

	p := h.run()

	if !h.exists("photo.png") {
		t.Fatal("original still referenced by properties/canvas was retired")
	}
	if h.read("a.md") != "![p](photo.webp)\n" {
		t.Error("embedding note must still be updated")
	}
	if p.Stats().OriginalsStillReferenced != 1 {
		t.Errorf("unexpected stats %+v", p.Stats())
	}
}

func TestOriginalKeptWithoutVaultRoot(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.cfg.FilePath = h.path("a.md")
	h.cfg.VaultPath = ""
	h.write("a.md", []byte("![p](pic.png)\n"))
	h.write("pic.png", pngBytes(t, 32))

	h.run()

	if !h.exists("pic.png") {
		t.Error("without --vault other references are unknown: the original must stay")
	}
	if h.read("a.md") != "![p](pic.webp)\n" {
		t.Error("the processed note must be updated")
	}
}

func TestKeepBackupFalse(t *testing.T) {
	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	h.cfg.KeepBackup = false
	srv, _ := imageServer(t, nil)
	h.write("a.md", []byte("![p](pic.png) ![r]("+srv.URL+"/r.png)\n"))
	h.write("pic.png", pngBytes(t, 32))

	h.run()

	if h.exists("pic.png") {
		t.Error("original must be deleted with --keep-backup=false")
	}
	if h.exists(".originals_backup") || h.exists("attachments/.originals_backup") {
		t.Error("no backup folder may be created with --keep-backup=false")
	}
	h.assertNoTempFiles()
}

func TestLocalLinksOutsideVaultAreIgnored(t *testing.T) {
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.png"), pngBytes(t, 16), 0o644); err != nil {
		t.Fatal(err)
	}

	h := newHarness(t)
	h.cfg.OptimizeLocal = true
	rel, _ := filepath.Rel(h.vault, filepath.Join(outside, "secret.png"))
	content := "![x](" + filepath.ToSlash(rel) + ")\n"
	h.write("a.md", []byte(content))

	link := h.path("link.png")
	if err := os.Symlink(filepath.Join(outside, "secret.png"), link); err == nil {
		content += "![y](link.png)\n"
		h.write("a.md", []byte(content))
	}

	h.run()

	if h.read("a.md") != content {
		t.Errorf("links outside the vault must not be rewritten:\n%s", h.read("a.md"))
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 1 {
		t.Errorf("files outside the vault were touched: %d entries", len(entries))
	}
}

func TestEmptyVault(t *testing.T) {
	h := newHarness(t)
	p := h.run()
	if s := p.Stats(); s.FilesScanned != 0 || s.Errors != 0 {
		t.Errorf("unexpected stats %+v", s)
	}
	if !strings.Contains(h.out.String(), "Optimization Complete") {
		t.Errorf("summary missing:\n%s", h.out)
	}
}
