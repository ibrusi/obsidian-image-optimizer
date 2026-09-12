package processor

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/downloader"
	"obsidian-image-optimizer/pkg/optimizer"
	"obsidian-image-optimizer/pkg/parser"
)

// SummaryStats contains metrics of the optimization run.
type SummaryStats struct {
	TotalFilesScanned   int
	TotalFilesModified  int
	TotalImagesFound    int
	TotalWebpConverted  int
	TotalKeptOriginal   int
	TotalErrors         int
	TotalOriginalBytes  int64
	TotalOptimizedBytes int64
}

// FormatHumanBytes formats a byte count into a human-readable string (KB, MB).
func FormatHumanBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// Processor manages the processing pipeline for markdown files and vaults.
type Processor struct {
	cfg        *config.Config
	downloader *downloader.Downloader
	stats      SummaryStats
}

// NewProcessor creates an initialized Processor.
func NewProcessor(cfg *config.Config) *Processor {
	return &Processor{
		cfg:        cfg,
		downloader: downloader.NewDownloader(cfg.TimeoutSeconds, cfg.UserAgent),
	}
}

// Stats returns the accumulated statistics.
func (p *Processor) Stats() SummaryStats {
	return p.stats
}

// Run executes the optimization process based on the config.
func (p *Processor) Run(ctx context.Context) error {
	if p.cfg.FilePath != "" {
		return p.ProcessFile(ctx, p.cfg.FilePath)
	}

	if p.cfg.VaultPath != "" {
		return p.ProcessVault(ctx, p.cfg.VaultPath)
	}

	return fmt.Errorf("no file or vault specified")
}

// ProcessVault recursively scans and processes all markdown files in a vault directory.
func (p *Processor) ProcessVault(ctx context.Context, vaultDir string) error {
	fmt.Printf("🔍 Scanning vault: %s\n", vaultDir)

	var mdFiles []string

	err := filepath.WalkDir(vaultDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		name := d.Name()
		if d.IsDir() {
			// Skip hidden and internal directories
			if strings.HasPrefix(name, ".") || name == p.cfg.AttachedDir || name == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}

		if strings.EqualFold(filepath.Ext(path), ".md") {
			mdFiles = append(mdFiles, path)
		}
		return nil
	})

	if err != nil {
		return fmt.Errorf("vault traversal failed: %w", err)
	}

	fmt.Printf("📄 Found %d markdown file(s)\n\n", len(mdFiles))

	for _, file := range mdFiles {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		if err := p.ProcessFile(ctx, file); err != nil {
			fmt.Printf("❌ Error processing %s: %v\n", file, err)
			p.stats.TotalErrors++
		}
	}

	p.printFinalReport()
	return nil
}

// ProcessFile processes a single markdown file: extracts links, downloads images, converts to WebP, replaces links.
func (p *Processor) ProcessFile(ctx context.Context, filePath string) error {
	p.stats.TotalFilesScanned++

	contentBytes, err := os.ReadFile(filePath)
	if err != nil {
		return fmt.Errorf("failed to read file: %w", err)
	}

	content := string(contentBytes)
	images := parser.ExtractRemoteImages(content)
	var localImages []parser.LocalImage
	if p.cfg.OptimizeLocal {
		localImages = parser.ExtractLocalImages(content)
	}

	if len(images) == 0 && len(localImages) == 0 {
		if p.cfg.Verbose {
			fmt.Printf("⏩ No compressible images in %s\n", filepath.Base(filePath))
		}
		return nil
	}

	if len(images) > 0 {
		fmt.Printf("📝 [%s] Found %d remote image(s)\n", filepath.Base(filePath), len(images))
	}
	if len(localImages) > 0 {
		fmt.Printf("📁 [%s] Found %d local image(s) to optimize\n", filepath.Base(filePath), len(localImages))
	}

	noteDir := filepath.Dir(filePath)
	attachedDir := filepath.Join(noteDir, p.cfg.AttachedDir)

	urlToRelPath := make(map[string]string)

	for _, img := range images {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		rawURL := img.URL
		if _, alreadyProcessed := urlToRelPath[rawURL]; alreadyProcessed {
			continue
		}

		p.stats.TotalImagesFound++
		fmt.Printf("   ⬇️  Downloading: %s\n", truncateURL(rawURL, 60))

		if p.cfg.DryRun {
			urlToRelPath[rawURL] = filepath.Join(p.cfg.AttachedDir, "preview.webp")
			continue
		}

		// Download to attached directory
		dl, err := p.downloader.Download(ctx, rawURL, attachedDir)
		if err != nil {
			fmt.Printf("   ⚠️  Failed to download %s: %v\n", rawURL, err)
			p.stats.TotalErrors++
			continue
		}

		// Optimize with WebP & GIF handling
		optRes, err := optimizer.Optimize(dl.LocalPath, attachedDir, noteDir, p.cfg)
		if err != nil {
			fmt.Printf("   ⚠️  Failed to optimize %s: %v\n", dl.Filename, err)
			p.stats.TotalErrors++
			continue
		}

		p.stats.TotalOriginalBytes += optRes.OriginalSize
		p.stats.TotalOptimizedBytes += optRes.FinalSize

		if optRes.KeptOriginal {
			p.stats.TotalKeptOriginal++
			fmt.Printf("   ℹ️  Kept original %s (%s, candidate was not smaller)\n",
				filepath.Base(optRes.FinalPath), FormatHumanBytes(optRes.FinalSize))
		} else {
			p.stats.TotalWebpConverted++
			fmt.Printf("   ✨ Compressed %s -> %s (%s -> %s, -%.1f%%)\n",
				filepath.Base(optRes.OriginalPath),
				filepath.Base(optRes.FinalPath),
				FormatHumanBytes(optRes.OriginalSize),
				FormatHumanBytes(optRes.FinalSize),
				optRes.SavingsPercent,
			)
		}

		urlToRelPath[rawURL] = optRes.RelativePath
	}

	// Optimize local images if enabled
	localToNewPath := make(map[string]string)
	for _, lImg := range localImages {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		localRelPath := filepath.FromSlash(lImg.Path)
		absPath := filepath.Join(noteDir, localRelPath)
		if _, err := os.Stat(absPath); err != nil {
			// Might be relative to vault root
			if p.cfg.VaultPath != "" {
				absPath = filepath.Join(p.cfg.VaultPath, localRelPath)
			}
		}

		if _, err := os.Stat(absPath); err != nil {
			if p.cfg.Verbose {
				fmt.Printf("   ⚠️  Local file not found: %s\n", lImg.Path)
			}
			continue
		}

		p.stats.TotalImagesFound++
		imgAttachedDir := filepath.Dir(absPath)

		optRes, err := optimizer.Optimize(absPath, imgAttachedDir, noteDir, p.cfg)
		if err != nil {
			p.stats.TotalErrors++
			continue
		}

		p.stats.TotalOriginalBytes += optRes.OriginalSize
		p.stats.TotalOptimizedBytes += optRes.FinalSize

		if optRes.KeptOriginal {
			p.stats.TotalKeptOriginal++
			if p.cfg.Verbose {
				fmt.Printf("   ℹ️  Kept original %s (was already optimal)\n", filepath.Base(absPath))
			}
		} else {
			p.stats.TotalWebpConverted++
			fmt.Printf("   ✨ Compressed local %s -> %s (-%.1f%%)\n",
				filepath.Base(optRes.OriginalPath),
				filepath.Base(optRes.FinalPath),
				optRes.SavingsPercent,
			)

			// Calculate new relative link matching the original link style
			origDir := filepath.Dir(lImg.Path)
			newFileName := filepath.Base(optRes.FinalPath)
			var newRelLink string
			if origDir == "." || origDir == "" {
				newRelLink = newFileName
			} else {
				newRelLink = filepath.ToSlash(filepath.Join(origDir, newFileName))
			}
			localToNewPath[lImg.Path] = newRelLink
		}
	}

	if len(urlToRelPath) == 0 && len(localToNewPath) == 0 {
		return nil
	}

	if p.cfg.DryRun {
		fmt.Printf("   [DRY-RUN] Would update %d remote and %d local link(s) in %s\n",
			len(urlToRelPath), len(localToNewPath), filepath.Base(filePath))
		return nil
	}

	newContent := content
	if len(urlToRelPath) > 0 {
		newContent = parser.ReplaceRemoteLinks(newContent, urlToRelPath, p.cfg.LinkFormat)
	}
	if len(localToNewPath) > 0 {
		newContent = parser.ReplaceLocalLinks(newContent, localToNewPath)
	}

	if newContent != content {
		// Atomic file write
		tmpPath := filePath + ".tmp"
		if err := os.WriteFile(tmpPath, []byte(newContent), 0644); err != nil {
			return fmt.Errorf("failed to write updated file: %w", err)
		}
		if err := os.Rename(tmpPath, filePath); err != nil {
			return fmt.Errorf("failed to replace original markdown file: %w", err)
		}
		p.stats.TotalFilesModified++
		fmt.Printf("   💾 Updated %d image link(s) in %s\n",
			len(urlToRelPath)+len(localToNewPath), filepath.Base(filePath))
	}

	return nil
}

func (p *Processor) printFinalReport() {
	fmt.Printf("\n==========================================\n")
	fmt.Printf("🎉 Optimization Complete!\n")
	fmt.Printf("==========================================\n")
	fmt.Printf("📄 Files scanned:           %d\n", p.stats.TotalFilesScanned)
	fmt.Printf("✏️  Files updated:           %d\n", p.stats.TotalFilesModified)
	fmt.Printf("🖼️  Images processed:        %d\n", p.stats.TotalImagesFound)
	fmt.Printf("✨ WebP compressed:         %d\n", p.stats.TotalWebpConverted)
	fmt.Printf("📦 Originals kept (smaller): %d\n", p.stats.TotalKeptOriginal)
	if p.stats.TotalErrors > 0 {
		fmt.Printf("⚠️  Errors encountered:      %d\n", p.stats.TotalErrors)
	}

	if p.stats.TotalOriginalBytes > 0 {
		saved := p.stats.TotalOriginalBytes - p.stats.TotalOptimizedBytes
		var pct float64
		if p.stats.TotalOriginalBytes > 0 {
			pct = float64(saved) / float64(p.stats.TotalOriginalBytes) * 100
		}
		fmt.Printf("📊 Original total size:     %s\n", FormatHumanBytes(p.stats.TotalOriginalBytes))
		fmt.Printf("💾 Optimized total size:    %s\n", FormatHumanBytes(p.stats.TotalOptimizedBytes))
		fmt.Printf("🚀 Total space saved:       %s (-%.1f%%)\n", FormatHumanBytes(saved), pct)
	}
	fmt.Printf("==========================================\n\n")
}

func truncateURL(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}
