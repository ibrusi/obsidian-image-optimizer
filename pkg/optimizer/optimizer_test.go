package optimizer

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/imageinfo"
	"obsidian-image-optimizer/pkg/imagekind"
)

// fakeRunner simulates external encoders: each tool writes an output of a
// configured size or fails with a configured error.
type fakeRunner struct {
	mu    sync.Mutex
	sizes map[string]int   // tool -> output size
	fail  map[string]error // tool -> error
	calls []string
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) error {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()

	if err := f.fail[name]; err != nil {
		return err
	}
	return os.WriteFile(outputArg(args), make([]byte, f.sizes[name]), 0o644)
}

func (f *fakeRunner) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// outputArg finds the destination: the argument after "-o", else the last
// argument (ffmpeg) without its "file:" prefix.
func outputArg(args []string) string {
	for i, a := range args {
		if a == "-o" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return strings.TrimPrefix(args[len(args)-1], "file:")
}

var allTools = Toolchain{Cwebp: "cwebp", Ffmpeg: "ffmpeg", Gifsicle: "gifsicle", Gif2webp: "gif2webp"}

func defaultOptions() Options {
	return OptionsFromConfig(config.DefaultConfig())
}

func writeTestFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func gradientPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: uint8(x ^ y), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func animatedGIF(t *testing.T, w, h, frames int) []byte {
	t.Helper()
	pal := color.Palette{color.Transparent}
	for i := 1; i < 256; i++ {
		pal = append(pal, color.RGBA{R: uint8(i), G: uint8(255 - i), B: uint8(i * 7), A: 255})
	}
	g := &gif.GIF{Config: image.Config{Width: w, Height: h, ColorModel: pal}}
	for f := 0; f < frames; f++ {
		img := image.NewPaletted(image.Rect(0, 0, w, h), pal)
		for i := range img.Pix {
			img.Pix[i] = uint8((i + f*13) % 256)
		}
		g.Image = append(g.Image, img)
		g.Delay = append(g.Delay, 4)
		g.Disposal = append(g.Disposal, gif.DisposalNone)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// dirEntries lists file names in dir (excluding nothing).
func dirEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	return names
}

func TestOptimizeKeepsSourceAndReturnsCandidate(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 64, 64))
	run := &fakeRunner{sizes: map[string]int{"cwebp": 10}}

	res, err := New(allTools, run, defaultOptions()).Optimize(context.Background(), src, imagekind.PNG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Improved() || res.Ext != ".webp" || res.Encoder != "cwebp" || res.FinalSize != 10 {
		t.Fatalf("unexpected result %+v", res)
	}
	if !strings.HasPrefix(filepath.Base(res.Candidate), ".imgopt-") {
		t.Errorf("candidate must be a temp file, got %s", res.Candidate)
	}
	if _, err := os.Stat(src); err != nil {
		t.Error("source must not be touched")
	}
}

func TestOptimizeFallsBackToNextEncoder(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.jpg", []byte("\xFF\xD8\xFF"+strings.Repeat("x", 1000)))
	run := &fakeRunner{
		sizes: map[string]int{"ffmpeg": 20},
		fail:  map[string]error{"cwebp": errors.New("boom")},
	}

	res, err := New(allTools, run, defaultOptions()).Optimize(context.Background(), src, imagekind.JPEG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Improved() || res.Encoder != "ffmpeg" {
		t.Fatalf("expected ffmpeg fallback, got %+v", res)
	}
	if got := run.called(); strings.Join(got, ",") != "cwebp,ffmpeg" {
		t.Errorf("unexpected call order %v", got)
	}
}

func TestOptimizeNotSmallerKeepsOriginalAndCleansUp(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 8, 8))
	info, _ := os.Stat(src)
	run := &fakeRunner{sizes: map[string]int{"cwebp": int(info.Size())}}

	res, err := New(allTools, run, defaultOptions()).Optimize(context.Background(), src, imagekind.PNG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Improved() || !strings.Contains(res.KeptReason, "not smaller") {
		t.Fatalf("expected original to be kept, got %+v", res)
	}
	if names := dirEntries(t, dir); len(names) != 1 {
		t.Errorf("temp files left behind: %v", names)
	}
}

func TestOptimizeReportsEncoderErrors(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 8, 8))
	run := &fakeRunner{fail: map[string]error{"cwebp": errors.New("cwebp broke"), "ffmpeg": errors.New("ffmpeg broke")}}

	res, err := New(allTools, run, defaultOptions()).Optimize(context.Background(), src, imagekind.PNG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Improved() || res.EncodeErr == nil {
		t.Fatalf("expected encode error, got %+v", res)
	}
	for _, msg := range []string{"cwebp broke", "ffmpeg broke"} {
		if !strings.Contains(res.EncodeErr.Error(), msg) {
			t.Errorf("error %q does not mention %q", res.EncodeErr, msg)
		}
	}
	if names := dirEntries(t, dir); len(names) != 1 {
		t.Errorf("temp files left behind: %v", names)
	}
}

func TestOptimizeWithoutTools(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 8, 8))

	res, err := New(Toolchain{}, &fakeRunner{}, defaultOptions()).Optimize(context.Background(), src, imagekind.PNG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Improved() || !errors.Is(res.EncodeErr, errNoEncoder) {
		t.Fatalf("expected errNoEncoder, got %+v", res)
	}
}

func TestOptimizeSkipsVectorAndAnimatedStills(t *testing.T) {
	dir := t.TempDir()
	animatedWebP := append([]byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00"), 0x02, 0, 0, 0, 0)
	cases := []struct {
		name string
		data []byte
		kind imagekind.Kind
	}{
		{"a.svg", []byte("<svg/>"), imagekind.SVG},
		{"b.webp", animatedWebP, imagekind.WebP},
	}
	run := &fakeRunner{sizes: map[string]int{"cwebp": 1}}
	opt := New(allTools, run, defaultOptions())

	for _, c := range cases {
		src := writeTestFile(t, dir, c.name, c.data)
		res, err := opt.Optimize(context.Background(), src, c.kind, dir)
		if err != nil {
			t.Fatal(err)
		}
		if res.Improved() {
			t.Errorf("%s must be kept", c.name)
		}
	}
	if len(run.called()) != 0 {
		t.Errorf("no encoder may run, got %v", run.called())
	}
}

func TestGIFModes(t *testing.T) {
	animated := animatedGIF(t, 16, 16, 3)
	var staticBuf bytes.Buffer
	if err := gif.Encode(&staticBuf, image.NewPaletted(image.Rect(0, 0, 16, 16), color.Palette{color.Black, color.White}), nil); err != nil {
		t.Fatal(err)
	}
	static := staticBuf.Bytes()

	tests := []struct {
		name        string
		mode        config.GifMode
		data        []byte
		sizes       map[string]int
		wantExt     string
		wantEncoder string
	}{
		{"keep animated", config.GifModeKeep, animated, map[string]int{"gif2webp": 1}, "", ""},
		{"keep static", config.GifModeKeep, static, map[string]int{"gif2webp": 1}, "", ""},
		{"webp", config.GifModeWebp, animated, map[string]int{"gif2webp": 5}, ".webp", "gif2webp"},
		{"webp without fallback to gif", config.GifModeWebp, animated, map[string]int{"gif2webp": 1 << 20, "ffmpeg": 1 << 20, "gifsicle": 5}, "", ""},
		{"optimize", config.GifModeOptimize, animated, map[string]int{"gif2webp": 1, "gifsicle": 5}, ".gif", "gifsicle"},
		{"auto falls back to gif", config.GifModeAuto, animated, map[string]int{"gif2webp": 1 << 20, "ffmpeg": 1 << 20, "gifsicle": 5}, ".gif", "gifsicle"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			src := writeTestFile(t, dir, "anim.gif", tt.data)
			opts := defaultOptions()
			opts.GifMode = tt.mode

			res, err := New(allTools, &fakeRunner{sizes: tt.sizes}, opts).Optimize(context.Background(), src, imagekind.GIF, dir)
			if err != nil {
				t.Fatal(err)
			}
			if res.Ext != tt.wantExt || res.Encoder != tt.wantEncoder {
				t.Errorf("got ext=%q encoder=%q (%s), want ext=%q encoder=%q", res.Ext, res.Encoder, res.KeptReason, tt.wantExt, tt.wantEncoder)
			}
		})
	}
}

func TestEncoderArguments(t *testing.T) {
	var got [][]string
	run := runnerFunc(func(name string, args ...string) error {
		got = append(got, append([]string{name}, args...))
		return errors.New("stop")
	})
	opts := defaultOptions()
	opts.GifMaxWidth = 100
	opt := New(allTools, run, opts)

	dir := t.TempDir()
	src := writeTestFile(t, dir, "a.gif", animatedGIF(t, 200, 10, 2))
	if _, err := opt.Optimize(context.Background(), src, imagekind.GIF, dir); err != nil {
		t.Fatal(err)
	}

	joined := make([]string, len(got))
	for i, c := range got {
		joined[i] = strings.Join(c, " ")
	}
	all := strings.Join(joined, "\n")

	if strings.Contains(all, "gif2webp") {
		t.Error("gif2webp cannot resize and must be skipped when gif-max-width applies")
	}
	for _, want := range []string{"-nostdin", "scale=100:-2", "libwebp_anim", "--resize-fit-width 100", "--lossy=80", "--colors 128", "palettegen=max_colors=128"} {
		if !strings.Contains(all, want) {
			t.Errorf("expected %q in commands:\n%s", want, all)
		}
	}
}

type runnerFunc func(name string, args ...string) error

func (f runnerFunc) Run(_ context.Context, name string, args ...string) error {
	return f(name, args...)
}

func TestGoGIFRejectsDecompressionBomb(t *testing.T) {
	dir := t.TempDir()
	src := writeTestFile(t, dir, "bomb.gif", animatedGIF(t, 100, 100, 5))
	opts := defaultOptions()
	opts.MaxPixels = 100 * 100 * 4 // less than 5 frames

	res, err := New(Toolchain{}, &fakeRunner{}, opts).Optimize(context.Background(), src, imagekind.GIF, dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Improved() || res.EncodeErr == nil || !errors.Is(res.EncodeErr, errTooManyPixels) {
		t.Fatalf("expected errTooManyPixels, got %+v", res)
	}
}

func TestReducePalettesKeepsTransparencyAndFrames(t *testing.T) {
	data := animatedGIF(t, 32, 32, 4)
	g, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}

	out := reducePalettes(g, 16)
	if len(out.Image) != 4 {
		t.Fatalf("expected 4 frames, got %d", len(out.Image))
	}
	for i, frame := range out.Image {
		if len(frame.Palette) > 16 {
			t.Errorf("frame %d palette has %d colours", i, len(frame.Palette))
		}
		for j, idx := range g.Image[i].Pix {
			srcTransparent := isTransparent(g.Image[i].Palette[idx])
			dstTransparent := isTransparent(frame.Palette[frame.Pix[j]])
			if srcTransparent != dstTransparent {
				t.Fatalf("frame %d pixel %d: transparency changed (%v -> %v)", i, j, srcTransparent, dstTransparent)
			}
		}
	}

	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		t.Fatalf("reduced GIF cannot be encoded: %v", err)
	}
}

func TestDropAlternateFramesComposites(t *testing.T) {
	// Frame 0 paints the full screen red; later frames are small deltas.
	pal := color.Palette{color.Transparent, color.RGBA{255, 0, 0, 255}, color.RGBA{0, 0, 255, 255}}
	g := &gif.GIF{Config: image.Config{Width: 10, Height: 10, ColorModel: pal}}
	full := image.NewPaletted(image.Rect(0, 0, 10, 10), pal)
	for i := range full.Pix {
		full.Pix[i] = 1
	}
	g.Image = append(g.Image, full)
	g.Delay = append(g.Delay, 10)
	g.Disposal = append(g.Disposal, gif.DisposalNone)
	for i := 1; i < 12; i++ {
		delta := image.NewPaletted(image.Rect(i%10, 0, i%10+1, 1), pal)
		delta.Pix[0] = 2
		g.Image = append(g.Image, delta)
		g.Delay = append(g.Delay, 10)
		g.Disposal = append(g.Disposal, gif.DisposalNone)
	}

	out := dropAlternateFrames(g, 8)
	if len(out.Image) != 6 {
		t.Fatalf("expected 6 frames, got %d", len(out.Image))
	}
	total := 0
	for _, d := range out.Delay {
		total += d
	}
	if total != 120 {
		t.Errorf("total delay must be preserved: got %d", total)
	}
	// Every kept frame is a full composited frame: the red background from
	// frame 0 must still be visible far from the deltas.
	for i, frame := range out.Image {
		if frame.Bounds() != image.Rect(0, 0, 10, 10) {
			t.Errorf("frame %d is not full-screen: %v", i, frame.Bounds())
		}
		if r, _, _, _ := frame.At(5, 9).RGBA(); r>>8 != 255 {
			t.Errorf("frame %d lost the background: %v", i, frame.At(5, 9))
		}
	}
}

func hasTool(t *testing.T, names ...string) {
	t.Helper()
	for _, n := range names {
		if _, err := exec.LookPath(n); err != nil {
			t.Skipf("%s not installed", n)
		}
	}
}

func realOptimizer() *Optimizer {
	return New(DiscoverToolchain(), ExecRunner{}, defaultOptions())
}

func TestIntegrationPNGToWebP(t *testing.T) {
	hasTool(t, "cwebp")
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 200, 200))

	res, err := realOptimizer().Optimize(context.Background(), src, imagekind.PNG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Improved() {
		t.Fatalf("expected a smaller WebP, got %+v", res)
	}
	if kind, _ := imagekind.SniffFile(res.Candidate); kind != imagekind.WebP {
		t.Errorf("candidate is %q, not WebP", kind)
	}
}

func TestIntegrationExifOrientationApplied(t *testing.T) {
	hasTool(t, "cwebp", "webpinfo")
	dir := t.TempDir()

	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 400; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	src := writeTestFile(t, dir, "phone.jpg", withOrientation(buf.Bytes(), 6))

	res, err := realOptimizer().Optimize(context.Background(), src, imagekind.JPEG, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Improved() {
		t.Fatalf("expected a candidate, got %+v", res)
	}
	w, h := webpSize(t, res.Candidate)
	if w != 200 || h != 400 {
		t.Errorf("orientation 6 must rotate 400x200 to 200x400, got %dx%d", w, h)
	}
	for _, name := range dirEntries(t, dir) {
		if strings.HasSuffix(name, ".png") {
			t.Errorf("rotation temp file left behind: %s", name)
		}
	}
}

func TestIntegrationAnimatedGIFToWebP(t *testing.T) {
	hasTool(t, "gif2webp")
	dir := t.TempDir()
	src := writeTestFile(t, dir, "anim.gif", animatedGIF(t, 64, 64, 6))

	res, err := realOptimizer().Optimize(context.Background(), src, imagekind.GIF, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Improved() {
		t.Skipf("synthetic GIF did not shrink: %s", res.KeptReason)
	}
	f, _ := os.Open(res.Candidate)
	defer f.Close()
	if res.Ext == ".webp" && !imageinfo.IsAnimatedWebP(f) {
		t.Error("animation was lost")
	}
}

func TestIntegrationCancellation(t *testing.T) {
	hasTool(t, "cwebp")
	dir := t.TempDir()
	src := writeTestFile(t, dir, "pic.png", gradientPNG(t, 64, 64))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := realOptimizer().Optimize(ctx, src, imagekind.PNG, dir); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if names := dirEntries(t, dir); len(names) != 1 {
		t.Errorf("temp files left behind: %v", names)
	}
}

// withOrientation injects an EXIF APP1 segment with the given orientation.
func withOrientation(jpg []byte, orientation int) []byte {
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00")
	binary.BigEndian.PutUint16(tiff[18:], uint16(orientation))
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

func webpSize(t *testing.T, path string) (int, int) {
	t.Helper()
	out, err := exec.Command("webpinfo", path).Output()
	if err != nil {
		t.Fatal(err)
	}
	var w, h int
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "Width: "); ok && w == 0 {
			w = atoi(v)
		}
		if v, ok := strings.CutPrefix(line, "Height: "); ok && h == 0 {
			h = atoi(v)
		}
	}
	return w, h
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}
