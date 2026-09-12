package processor

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"obsidian-image-optimizer/pkg/config"
)

func TestProcessorE2E(t *testing.T) {
	// 1. Create a fake PNG image
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 120, A: 255})
		}
	}
	var pngBuf bytes.Buffer
	if err := png.Encode(&pngBuf, img); err != nil {
		t.Fatalf("failed to encode test png: %v", err)
	}

	// 2. Setup HTTP test server serving the image
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.WriteHeader(http.StatusOK)
		w.Write(pngBuf.Bytes())
	}))
	defer server.Close()

	// 3. Setup temporary Obsidian vault
	tmpVault := t.TempDir()
	testNotePath := filepath.Join(tmpVault, "My Note.md")

	initialContent := `# Sample Obsidian Note

Here is a remote diagram:
![Diagram 1](` + server.URL + `/diagram1.png "Diagram Title")

And an HTML image:
<img src="` + server.URL + `/screenshot.png" alt="Screenshot">

Some other text.
`
	if err := os.WriteFile(testNotePath, []byte(initialContent), 0644); err != nil {
		t.Fatalf("failed to write initial note: %v", err)
	}

	// 4. Configure processor
	cfg := config.DefaultConfig()
	cfg.VaultPath = tmpVault
	cfg.Quality = 20
	cfg.AttachedDir = "attached"
	cfg.BackupDir = ".backup"

	proc := NewProcessor(cfg)

	// 5. Run processor
	if err := proc.Run(context.Background()); err != nil {
		t.Fatalf("processor failed: %v", err)
	}

	stats := proc.Stats()
	if stats.TotalFilesModified != 1 {
		t.Fatalf("expected 1 file modified, got %d", stats.TotalFilesModified)
	}
	if stats.TotalWebpConverted != 2 {
		t.Fatalf("expected 2 images converted, got %d", stats.TotalWebpConverted)
	}

	// 6. Verify modified markdown content
	updatedBytes, err := os.ReadFile(testNotePath)
	if err != nil {
		t.Fatal(err)
	}
	updatedContent := string(updatedBytes)

	// Must NOT contain server.URL anymore
	if strings.Contains(updatedContent, server.URL) {
		t.Fatalf("updated markdown still contains remote URL:\n%s", updatedContent)
	}

	// Must contain attached/ and .webp
	if !strings.Contains(updatedContent, "attached/") || !strings.Contains(updatedContent, ".webp") {
		t.Fatalf("expected attached/ and .webp in markdown, got:\n%s", updatedContent)
	}

	// 7. Verify attached directory and files exist
	attachedDir := filepath.Join(tmpVault, "attached")
	backupDir := filepath.Join(attachedDir, ".backup")

	if _, err := os.Stat(attachedDir); os.IsNotExist(err) {
		t.Fatalf("attached directory not created: %s", attachedDir)
	}
	if _, err := os.Stat(backupDir); os.IsNotExist(err) {
		t.Fatalf("backup directory not created: %s", backupDir)
	}

	// Read files in attachedDir
	entries, err := os.ReadDir(attachedDir)
	if err != nil {
		t.Fatal(err)
	}
	var webpCount int
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".webp") {
			webpCount++
		}
	}
	if webpCount != 2 {
		t.Fatalf("expected 2 webp files in %s, found %d", attachedDir, webpCount)
	}
}
