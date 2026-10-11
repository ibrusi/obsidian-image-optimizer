package downloader

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"obsidian-image-optimizer/pkg/imagekind"
)

var fakePNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4")

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/test-image.png", "/no-ext":
			w.Header().Set("Content-Type", "image/png")
			w.Write(fakePNG)
		case "/lying.jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			w.Write(fakePNG) // content wins over the claimed type
		case "/hotlink.png":
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<html><body>Hotlinking denied</body></html>"))
		case "/drawing.svg":
			w.Header().Set("Content-Type", "image/svg+xml")
			w.Write([]byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`))
		case "/big-declared":
			w.Header().Set("Content-Length", "10000000")
			w.Write(fakePNG)
		case "/big-streamed":
			w.Header().Set("Content-Type", "image/png")
			w.(http.Flusher).Flush() // chunked: no Content-Length
			w.Write(fakePNG)
			w.Write(make([]byte, 4096))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestDownloader(maxBytes int64) *Downloader {
	return New(Options{Timeout: 5 * time.Second, UserAgent: "TestAgent", MaxBytes: maxBytes, AllowPrivateHosts: true})
}

func assertNoFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected no files left in %s, found %d", dir, len(entries))
	}
}

func TestDownload(t *testing.T) {
	srv := newServer(t)
	dir := t.TempDir()
	dl := newTestDownloader(1 << 20)

	res1, err := dl.Download(context.Background(), srv.URL+"/test-image.png", dir)
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	if res1.Kind != imagekind.PNG || !strings.HasSuffix(res1.TempPath, ".png") {
		t.Errorf("unexpected result %+v", res1)
	}
	if !strings.HasPrefix(res1.BaseName, "test-image_") {
		t.Errorf("unexpected base name %q", res1.BaseName)
	}
	data, err := os.ReadFile(res1.TempPath)
	if err != nil || string(data) != string(fakePNG) || res1.Size != int64(len(fakePNG)) {
		t.Errorf("downloaded content mismatch (%v)", err)
	}

	res2, err := dl.Download(context.Background(), srv.URL+"/no-ext", dir)
	if err != nil {
		t.Fatalf("download no-ext failed: %v", err)
	}
	if res2.Kind != imagekind.PNG {
		t.Errorf("expected PNG from magic bytes, got %q", res2.Kind)
	}
	if res1.BaseName == res2.BaseName || res1.TempPath == res2.TempPath {
		t.Error("names collided")
	}
}

func TestDownloadTrustsContentOverHeaders(t *testing.T) {
	srv := newServer(t)
	res, err := newTestDownloader(1<<20).Download(context.Background(), srv.URL+"/lying.jpg", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != imagekind.PNG {
		t.Errorf("expected PNG, got %q", res.Kind)
	}
}

func TestDownloadRejectsNonImage(t *testing.T) {
	srv := newServer(t)
	dir := t.TempDir()
	_, err := newTestDownloader(1<<20).Download(context.Background(), srv.URL+"/hotlink.png", dir)
	if !errors.Is(err, ErrNotAnImage) {
		t.Fatalf("expected ErrNotAnImage, got %v", err)
	}
	assertNoFiles(t, dir)
}

func TestDownloadAcceptsSVG(t *testing.T) {
	srv := newServer(t)
	res, err := newTestDownloader(1<<20).Download(context.Background(), srv.URL+"/drawing.svg", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.Kind != imagekind.SVG {
		t.Errorf("expected SVG, got %q", res.Kind)
	}
}

func TestDownloadSizeLimit(t *testing.T) {
	srv := newServer(t)
	for _, path := range []string{"/big-declared", "/big-streamed"} {
		t.Run(path, func(t *testing.T) {
			dir := t.TempDir()
			_, err := newTestDownloader(1024).Download(context.Background(), srv.URL+path, dir)
			if !errors.Is(err, ErrTooLarge) {
				t.Fatalf("expected ErrTooLarge, got %v", err)
			}
			assertNoFiles(t, dir)
		})
	}
}

func TestDownloadHTTPError(t *testing.T) {
	srv := newServer(t)
	dir := t.TempDir()
	if _, err := newTestDownloader(1<<20).Download(context.Background(), srv.URL+"/missing.png", dir); err == nil {
		t.Fatal("expected an error for 404")
	}
	assertNoFiles(t, dir)
}

func TestDownloadBlocksPrivateHostsByDefault(t *testing.T) {
	srv := newServer(t) // listens on 127.0.0.1
	dir := t.TempDir()
	dl := New(Options{Timeout: 5 * time.Second, MaxBytes: 1 << 20})

	_, err := dl.Download(context.Background(), srv.URL+"/test-image.png", dir)
	if !errors.Is(err, ErrForbiddenHost) {
		t.Fatalf("expected ErrForbiddenHost, got %v", err)
	}
	assertNoFiles(t, dir)
}

func TestDownloadRejectsUnsupportedScheme(t *testing.T) {
	if _, err := newTestDownloader(1024).Download(context.Background(), "file:///etc/passwd", t.TempDir()); err == nil {
		t.Fatal("expected an error for file://")
	}
}

func TestIsPublicAddr(t *testing.T) {
	tests := map[string]bool{
		"8.8.8.8":         true,
		"2606:4700::1111": true,
		"127.0.0.1":       false,
		"10.1.2.3":        false,
		"172.16.0.1":      false,
		"192.168.1.1":     false,
		"169.254.169.254": false, // cloud metadata
		"100.64.0.1":      false, // CGNAT
		"0.0.0.0":         false,
		"::1":             false,
		"fe80::1":         false,
		"fd00::1":         false,
		"::ffff:10.0.0.1": false, // IPv4-mapped private
		"224.0.0.1":       false, // multicast
	}
	for addr, want := range tests {
		if got := isPublicAddr(netip.MustParseAddr(addr)); got != want {
			t.Errorf("isPublicAddr(%s) = %v, want %v", addr, got, want)
		}
	}
}

func TestProxiedTargetCheck(t *testing.T) {
	proxy := func(*http.Request) (*url.URL, error) { return url.Parse("http://127.0.0.1:3128") }
	check := proxiedTargetCheck(proxy, nil)

	if err := check(context.Background(), &url.URL{Scheme: "http", Host: "10.0.0.5"}); !errors.Is(err, ErrForbiddenHost) {
		t.Errorf("expected private literal IP to be rejected through a proxy, got %v", err)
	}
	if err := check(context.Background(), &url.URL{Scheme: "https", Host: "1.1.1.1"}); err != nil {
		t.Errorf("public IP rejected: %v", err)
	}

	direct := proxiedTargetCheck(func(*http.Request) (*url.URL, error) { return nil, nil }, nil)
	if err := direct(context.Background(), &url.URL{Scheme: "http", Host: "10.0.0.5"}); err != nil {
		t.Errorf("direct connections are checked at dial time, got %v", err)
	}
}

func TestBaseName(t *testing.T) {
	tests := []struct{ raw, prefix string }{
		{"https://x.com/path/My Photo (1).jpeg?s=1", "My_Photo__1"},
		{"https://x.com/image.png", "img"},
		{"https://x.com/", "img"},
		{"https://x.com/" + strings.Repeat("a", 100) + ".png", strings.Repeat("a", 40)},
	}
	for _, tt := range tests {
		u, _ := url.Parse(tt.raw)
		got := BaseName(u, tt.raw)
		if !strings.HasPrefix(got, tt.prefix+"_") || len(got) != len(tt.prefix)+9 {
			t.Errorf("BaseName(%q) = %q, want prefix %q + 8 hex chars", tt.raw, got, tt.prefix)
		}
	}
}
