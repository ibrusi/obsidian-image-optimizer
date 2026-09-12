package downloader

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDownload(t *testing.T) {
	// Setup test HTTP server
	fakeImageBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/test-image.png" {
			w.Header().Set("Content-Type", "image/png")
			w.WriteHeader(http.StatusOK)
			w.Write(fakeImageBytes)
			return
		}
		if r.URL.Path == "/no-ext" {
			w.Header().Set("Content-Type", "image/png")
			w.WriteHeader(http.StatusOK)
			w.Write(fakeImageBytes)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	destDir := t.TempDir()
	dl := NewDownloader(5, "TestAgent")

	// 1. Download with extension in URL
	res1, err := dl.Download(context.Background(), server.URL+"/test-image.png", destDir)
	if err != nil {
		t.Fatalf("download failed: %v", err)
	}
	if !strings.HasSuffix(res1.Filename, ".png") {
		t.Errorf("expected filename ending in .png, got %s", res1.Filename)
	}
	if _, err := os.Stat(res1.LocalPath); os.IsNotExist(err) {
		t.Fatalf("downloaded file not found: %s", res1.LocalPath)
	}

	// 2. Download without extension in URL (sniffing content-type)
	res2, err := dl.Download(context.Background(), server.URL+"/no-ext", destDir)
	if err != nil {
		t.Fatalf("download no-ext failed: %v", err)
	}
	if !strings.HasSuffix(res2.Filename, ".png") {
		t.Errorf("expected extension deduced as .png, got %s", res2.Filename)
	}

	// 3. Ensure distinct filenames (no collision)
	if filepath.Base(res1.LocalPath) == filepath.Base(res2.LocalPath) {
		t.Errorf("filenames collided: %s == %s", res1.Filename, res2.Filename)
	}
}
