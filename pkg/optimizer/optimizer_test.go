package optimizer

import (
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"obsidian-image-optimizer/pkg/config"
)

func createTestPNG(t *testing.T, filePath string, width, height int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	// Draw colorful gradient with text-like contrast
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r := uint8((x * 255) / width)
			g := uint8((y * 255) / height)
			b := uint8((x*3 + y*2) % 256)
			img.Set(x, y, color.RGBA{R: r, G: g, B: b, A: 255})
		}
	}
	f, err := os.Create(filePath)
	if err != nil {
		t.Fatalf("failed to create test png: %v", err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatalf("failed to encode png: %v", err)
	}
}

func createTestGIF(t *testing.T, filePath string, frames int) {
	t.Helper()
	palette := color.Palette{
		color.RGBA{R: 255, G: 255, B: 255, A: 255},
		color.RGBA{R: 0, G: 0, B: 0, A: 255},
		color.RGBA{R: 255, G: 0, B: 0, A: 255},
	}
	g := &gif.GIF{}
	for i := 0; i < frames; i++ {
		pal := image.NewPaletted(image.Rect(0, 0, 50, 50), palette)
		// fill frame
		draw.Draw(pal, pal.Bounds(), &image.Uniform{C: palette[i%len(palette)]}, image.Point{}, draw.Src)
		g.Image = append(g.Image, pal)
		g.Delay = append(g.Delay, 10)
		g.Disposal = append(g.Disposal, gif.DisposalNone)
	}
	f, err := os.Create(filePath)
	if err != nil {
		t.Fatalf("failed to create test gif: %v", err)
	}
	defer f.Close()
	if err := gif.EncodeAll(f, g); err != nil {
		t.Fatalf("failed to encode gif: %v", err)
	}
}

func TestOptimizePNG(t *testing.T) {
	tmpDir := t.TempDir()
	srcPng := filepath.Join(tmpDir, "sample.png")
	createTestPNG(t, srcPng, 300, 300)

	origInfo, err := os.Stat(srcPng)
	if err != nil {
		t.Fatal(err)
	}

	attachedDir := filepath.Join(tmpDir, "attached")
	cfg := config.DefaultConfig()
	cfg.Quality = 20

	res, err := Optimize(srcPng, attachedDir, tmpDir, cfg)
	if err != nil {
		t.Fatalf("optimize failed: %v", err)
	}

	// 1. Verify backup exists
	backupFile := filepath.Join(attachedDir, cfg.BackupDir, "sample.png")
	if _, err := os.Stat(backupFile); os.IsNotExist(err) {
		t.Fatalf("backup file does not exist at %s", backupFile)
	}

	// 2. Verify compression occurred and candidate was kept
	if res.KeptOriginal {
		t.Fatalf("expected webp candidate to be smaller than uncompressed png")
	}
	if res.FinalSize >= origInfo.Size() {
		t.Fatalf("expected final size (%d) < orig size (%d)", res.FinalSize, origInfo.Size())
	}
	if res.Format != "webp" {
		t.Fatalf("expected format webp, got %s", res.Format)
	}

	// 3. Verify final file exists on disk
	if _, err := os.Stat(res.FinalPath); os.IsNotExist(err) {
		t.Fatalf("final file not found on disk: %s", res.FinalPath)
	}
}

func TestOptimizeStaticGIF(t *testing.T) {
	tmpDir := t.TempDir()
	srcGif := filepath.Join(tmpDir, "static.gif")
	createTestGIF(t, srcGif, 1) // 1 frame = static

	attachedDir := filepath.Join(tmpDir, "attached")
	cfg := config.DefaultConfig()

	res, err := Optimize(srcGif, attachedDir, tmpDir, cfg)
	if err != nil {
		t.Fatalf("optimize static gif failed: %v", err)
	}

	// Backup must exist
	backupFile := filepath.Join(attachedDir, cfg.BackupDir, "static.gif")
	if _, err := os.Stat(backupFile); os.IsNotExist(err) {
		t.Fatalf("backup file does not exist at %s", backupFile)
	}

	// Should be converted or kept depending on size check
	if _, err := os.Stat(res.FinalPath); os.IsNotExist(err) {
		t.Fatalf("final file not found on disk: %s", res.FinalPath)
	}
}

func TestOptimizeAnimatedGIF(t *testing.T) {
	tmpDir := t.TempDir()
	srcGif := filepath.Join(tmpDir, "animated.gif")
	createTestGIF(t, srcGif, 5) // 5 frames

	attachedDir := filepath.Join(tmpDir, "attached")
	cfg := config.DefaultConfig()
	cfg.GifMode = "optimize" // test pure Go optimizer

	res, err := Optimize(srcGif, attachedDir, tmpDir, cfg)
	if err != nil {
		t.Fatalf("optimize animated gif failed: %v", err)
	}

	// Backup must exist
	backupFile := filepath.Join(attachedDir, cfg.BackupDir, "animated.gif")
	if _, err := os.Stat(backupFile); os.IsNotExist(err) {
		t.Fatalf("backup file does not exist at %s", backupFile)
	}

	if _, err := os.Stat(res.FinalPath); os.IsNotExist(err) {
		t.Fatalf("final file does not exist at %s", res.FinalPath)
	}
}

func TestOptimizeCandidateLargerKeptOriginal(t *testing.T) {
	tmpDir := t.TempDir()
	// Create a tiny 1x1 PNG which is already extremely small (~68 bytes)
	srcPng := filepath.Join(tmpDir, "tiny.png")
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.White)
	f, err := os.Create(srcPng)
	if err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	f.Close()

	attachedDir := filepath.Join(tmpDir, "attached")
	cfg := config.DefaultConfig()
	cfg.Quality = 100 // High quality makes webp larger than tiny 1x1 png

	res, err := Optimize(srcPng, attachedDir, tmpDir, cfg)
	if err != nil {
		t.Fatalf("optimize failed: %v", err)
	}

	// Should keep original if candidate >= origSize
	if res.KeptOriginal {
		// Candidate webp must have been deleted
		candWebp := filepath.Join(attachedDir, "tiny.webp")
		if _, err := os.Stat(candWebp); !os.IsNotExist(err) {
			t.Errorf("expected candidate webp %s to be deleted, but it still exists", candWebp)
		}
		// Original file must exist in attachedDir
		if _, err := os.Stat(res.FinalPath); os.IsNotExist(err) {
			t.Errorf("expected original file %s to exist in attachedDir", res.FinalPath)
		}
	}
}

