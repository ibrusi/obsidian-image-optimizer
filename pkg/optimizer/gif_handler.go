package optimizer

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"obsidian-image-optimizer/pkg/config"
)

// GIFProcessResult contains the outcome of processing a GIF image.
type GIFProcessResult struct {
	CandidatePath   string
	IsStatic        bool
	ConvertedToWebp bool
	Error           error
}

// ProcessGIF handles both static and animated GIFs using the configured strategy.
func ProcessGIF(origPath, destDir string, cfg *config.Config) (*GIFProcessResult, error) {
	f, err := os.Open(origPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open GIF file: %w", err)
	}
	defer f.Close()

	g, err := gif.DecodeAll(f)
	if err != nil {
		return nil, fmt.Errorf("failed to decode GIF: %w", err)
	}

	baseName := strings.TrimSuffix(filepath.Base(origPath), filepath.Ext(origPath))

	// Case 1: Static GIF (single frame) -> Can be converted directly to regular WebP!
	if len(g.Image) <= 1 {
		return &GIFProcessResult{
			IsStatic:        true,
			ConvertedToWebp: true,
		}, nil
	}

	// Case 2: Multi-frame (Animated) GIF
	// Strategy:
	// 2a. If GifMode is "auto" or "webp", check for gif2webp or ffmpeg to produce animated WebP.
	// 2b. If GifMode is "optimize" or external tools are missing, optimize GIF in Go (palette reduction & frame pruning).
	// 2c. If GifMode is "keep", do not touch.

	if cfg.GifMode == "keep" {
		return &GIFProcessResult{
			CandidatePath:   origPath,
			IsStatic:        false,
			ConvertedToWebp: false,
		}, nil
	}

	if cfg.GifMode == "auto" || cfg.GifMode == "webp" {
		// Check for gif2webp
		if gif2webpPath, err := exec.LookPath("gif2webp"); err == nil {
			webpOut := filepath.Join(destDir, baseName+".webp")
			cmd := exec.Command(gif2webpPath, "-q", fmt.Sprintf("%d", cfg.Quality), origPath, "-o", webpOut)
			if out, cmdErr := cmd.CombinedOutput(); cmdErr == nil {
				return &GIFProcessResult{
					CandidatePath:   webpOut,
					IsStatic:        false,
					ConvertedToWebp: true,
				}, nil
			} else if cfg.Verbose {
				fmt.Printf("[GIF] gif2webp failed: %s (%v), falling back...\n", string(out), cmdErr)
			}
		}

		// Check for ffmpeg
		if ffmpegPath, err := exec.LookPath("ffmpeg"); err == nil {
			webpOut := filepath.Join(destDir, baseName+".webp")
			// ffmpeg animated webp conversion
			cmd := exec.Command(ffmpegPath, "-y", "-i", origPath, "-vcodec", "libwebp",
				"-filter:v", "fps=fps=15", "-lossless", "0", "-q:v", fmt.Sprintf("%d", cfg.Quality),
				"-loop", "0", webpOut)
			if out, cmdErr := cmd.CombinedOutput(); cmdErr == nil {
				return &GIFProcessResult{
					CandidatePath:   webpOut,
					IsStatic:        false,
					ConvertedToWebp: true,
				}, nil
			} else if cfg.Verbose {
				fmt.Printf("[GIF] ffmpeg failed: %s (%v), falling back...\n", string(out), cmdErr)
			}
		}
	}

	// Case 2b: GIFsicle optimization (matches user's bash history: gifsicle -O3 --lossy=80)
	if gifsicleBin, err := exec.LookPath("gifsicle"); err == nil {
		candidateGif := filepath.Join(destDir, baseName+"_opt.gif")
		lossyArg := fmt.Sprintf("--lossy=%d", cfg.GifLossy)
		cmd := exec.Command(gifsicleBin, "-O3", lossyArg, origPath, "-o", candidateGif)
		if out, cmdErr := cmd.CombinedOutput(); cmdErr == nil {
			if info, statErr := os.Stat(candidateGif); statErr == nil && info.Size() > 0 {
				return &GIFProcessResult{
					CandidatePath:   candidateGif,
					IsStatic:        false,
					ConvertedToWebp: false,
				}, nil
			}
		} else if cfg.Verbose {
			fmt.Printf("[GIF] gifsicle failed: %s (%v), falling back...\n", string(out), cmdErr)
		}
	}

	// Case 2c: ffmpeg palettegen optimization (matches user's ffmpeg history)
	if ffmpegBin, err := exec.LookPath("ffmpeg"); err == nil {
		candidateGif := filepath.Join(destDir, baseName+"_opt.gif")
		vfFilter := "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse"
		cmd := exec.Command(ffmpegBin, "-y", "-i", origPath, "-vf", vfFilter, candidateGif)
		if out, cmdErr := cmd.CombinedOutput(); cmdErr == nil {
			if info, statErr := os.Stat(candidateGif); statErr == nil && info.Size() > 0 {
				return &GIFProcessResult{
					CandidatePath:   candidateGif,
					IsStatic:        false,
					ConvertedToWebp: false,
				}, nil
			}
		} else if cfg.Verbose {
			fmt.Printf("[GIF] ffmpeg palettegen failed: %s (%v), falling back...\n", string(out), cmdErr)
		}
	}

	// Case 2d: Pure Go GIF optimization (no external tools required)
	// Optimize palette and optionally drop every 2nd frame
	candidateGif := filepath.Join(destDir, baseName+"_opt.gif")
	if err := optimizeGIFPureGo(g, candidateGif, cfg); err != nil {
		return nil, fmt.Errorf("pure Go GIF optimization failed: %w", err)
	}

	return &GIFProcessResult{
		CandidatePath:   candidateGif,
		IsStatic:        false,
		ConvertedToWebp: false,
	}, nil
}

// optimizeGIFPureGo optimizes an animated GIF in Go by quantizing colors and adjusting frames.
func optimizeGIFPureGo(g *gif.GIF, outPath string, cfg *config.Config) error {
	newGif := &gif.GIF{
		LoopCount: g.LoopCount,
		Config:    g.Config,
	}

	maxColors := cfg.MaxColors
	if maxColors <= 0 || maxColors > 256 {
		maxColors = 128
	}

	totalFrames := len(g.Image)
	dropFrames := cfg.GifDropFrames && totalFrames > 10

	for i := 0; i < totalFrames; i++ {
		// If dropping frames, skip every 2nd frame and combine delay
		if dropFrames && i%2 == 1 {
			if len(newGif.Delay) > 0 {
				newGif.Delay[len(newGif.Delay)-1] += g.Delay[i]
			}
			continue
		}

		frame := g.Image[i]
		reducedFrame := quantizeFrame(frame, maxColors)
		newGif.Image = append(newGif.Image, reducedFrame)

		delay := 10
		if i < len(g.Delay) && g.Delay[i] > 0 {
			delay = g.Delay[i]
		}
		newGif.Delay = append(newGif.Delay, delay)

		var disposal byte = gif.DisposalNone
		if i < len(g.Disposal) {
			disposal = g.Disposal[i]
		}
		newGif.Disposal = append(newGif.Disposal, disposal)
	}

	outFile, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer outFile.Close()

	return gif.EncodeAll(outFile, newGif)
}

// quantizeFrame reduces the color palette of an image.Paletted to targetColors.
func quantizeFrame(src *image.Paletted, targetColors int) *image.Paletted {
	if len(src.Palette) <= targetColors {
		return src
	}

	// Subsample palette to targetColors, always keeping index 0 (often transparent)
	reducedPalette := make(color.Palette, 0, targetColors)
	reducedPalette = append(reducedPalette, src.Palette[0])

	step := float64(len(src.Palette)-1) / float64(targetColors-1)
	for c := 1; c < targetColors; c++ {
		idx := int(float64(c) * step)
		if idx >= len(src.Palette) {
			idx = len(src.Palette) - 1
		}
		reducedPalette = append(reducedPalette, src.Palette[idx])
	}

	bounds := src.Bounds()
	dst := image.NewPaletted(bounds, reducedPalette)
	draw.FloydSteinberg.Draw(dst, bounds, src, bounds.Min)
	return dst
}
