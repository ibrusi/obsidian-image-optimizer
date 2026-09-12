package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// Config holds all options for image downloading, conversion, and vault processing.
type Config struct {
	// VaultPath is the root path of the Obsidian vault or directory containing notes.
	VaultPath string

	// FilePath is an optional single markdown file to process.
	FilePath string

	// AttachedDir is the folder name where images will be saved, relative to the note (e.g. "attached").
	AttachedDir string

	// BackupDir is the folder name where original images are backed up before conversion.
	BackupDir string

	// Quality is the WebP lossy compression quality (0-100). Default is 20 (recommended minimum for legible text).
	Quality int

	// GifMode specifies how GIFs should be processed: "auto", "webp", "optimize", or "keep".
	// "auto" converts static GIFs to WebP, and animated GIFs to animated WebP (if gif2webp/ffmpeg is available) or optimizes palette.
	// "webp" attempts WebP conversion for all GIFs.
	// "optimize" optimizes GIF without converting to WebP (palette reduction/frame pruning).
	// "keep" keeps original GIF unchanged.
	GifMode string

	// GifDropFrames when true drops every second frame on high-framerate GIFs to save size.
	GifDropFrames bool

	// MaxColors is the maximum number of colors for GIF palette optimization (default: 128).
	MaxColors int

	// GifLossy is the lossy level for gifsicle (e.g. 80 or 90). Default: 80.
	GifLossy int

	// OptimizeLocal when true also finds and optimizes existing local images in the vault.
	OptimizeLocal bool

	// KeepBackup controls whether to preserve the original images in the backup folder.
	KeepBackup bool

	// LinkFormat controls how links are generated in markdown: "markdown" (default) or "wikilink".
	// "markdown": ![alt](attached/image.webp)
	// "wikilink": ![[attached/image.webp]]
	LinkFormat string

	// DryRun previews changes without writing files or downloading images.
	DryRun bool

	// Verbose outputs detailed processing logs.
	Verbose bool

	// TimeoutSeconds is the HTTP timeout for downloading images.
	TimeoutSeconds int

	// UserAgent is the HTTP User-Agent header for image downloads.
	UserAgent string
}

// DefaultConfig returns default configuration with recommended settings.
func DefaultConfig() *Config {
	return &Config{
		AttachedDir:    "attached",
		BackupDir:      ".originals_backup",
		Quality:        20, // Recommended: minimal quality where text remains sharp and legible
		GifMode:        "auto",
		GifDropFrames:  false,
		MaxColors:      128,
		GifLossy:       80,
		OptimizeLocal:  false,
		KeepBackup:     true,
		LinkFormat:     "markdown",
		DryRun:         false,
		Verbose:        false,
		TimeoutSeconds: 30,
		UserAgent:      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ObsidianImageOptimizer/1.0",
	}
}

// ParseFlags parses command-line arguments into a Config instance.
func ParseFlags() (*Config, error) {
	cfg := DefaultConfig()

	flag.StringVar(&cfg.VaultPath, "vault", "", "Path to the Obsidian vault or directory to process recursively")
	flag.StringVar(&cfg.VaultPath, "dir", "", "Alias for --vault")
	flag.StringVar(&cfg.FilePath, "file", "", "Path to a single markdown file to process")
	flag.StringVar(&cfg.AttachedDir, "attached-dir", cfg.AttachedDir, "Folder name for downloaded images (created alongside the note)")
	flag.StringVar(&cfg.AttachedDir, "attachments", cfg.AttachedDir, "Alias for --attached-dir")
	flag.StringVar(&cfg.BackupDir, "backup-dir", cfg.BackupDir, "Folder name for original backup images (created inside attached-dir)")
	flag.StringVar(&cfg.BackupDir, "backup", cfg.BackupDir, "Alias for --backup-dir")
	flag.IntVar(&cfg.Quality, "quality", cfg.Quality, "WebP lossy compression quality (0-100). Default is 20 (recommended text threshold)")
	flag.StringVar(&cfg.GifMode, "gif-mode", cfg.GifMode, "GIF processing mode: auto | webp | optimize | keep")
	flag.IntVar(&cfg.GifLossy, "gif-lossy", cfg.GifLossy, "Gifsicle lossy factor for GIF compression (default: 80)")
	flag.BoolVar(&cfg.GifDropFrames, "gif-drop-frames", cfg.GifDropFrames, "Drop every 2nd frame in high FPS animated GIFs for extra compression")
	flag.IntVar(&cfg.MaxColors, "gif-colors", cfg.MaxColors, "Maximum palette colors for GIF optimization (16-256)")
	flag.BoolVar(&cfg.OptimizeLocal, "optimize-local", cfg.OptimizeLocal, "Also convert and optimize existing local JPG/PNG/GIF images in notes")
	flag.BoolVar(&cfg.KeepBackup, "keep-backup", cfg.KeepBackup, "Keep original image backups in backup-dir")
	flag.StringVar(&cfg.LinkFormat, "link-format", cfg.LinkFormat, "Link format in markdown: markdown (default) or wikilink")
	flag.BoolVar(&cfg.DryRun, "dry-run", cfg.DryRun, "Show what would be downloaded and converted without modifying files")
	flag.BoolVar(&cfg.Verbose, "verbose", cfg.Verbose, "Enable verbose debug logs")
	flag.IntVar(&cfg.TimeoutSeconds, "timeout", cfg.TimeoutSeconds, "HTTP download timeout in seconds")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Obsidian Image Optimizer (Go)\n")
		fmt.Fprintf(os.Stderr, "Downloads remote images from Obsidian notes, converts to WebP (default 20%% quality),\n")
		fmt.Fprintf(os.Stderr, "handles GIFs, keeps backups, verifies size reduction, and updates markdown links.\n\n")
		fmt.Fprintf(os.Stderr, "Usage:\n")
		fmt.Fprintf(os.Stderr, "  obsidian-img-opt --file path/to/note.md\n")
		fmt.Fprintf(os.Stderr, "  obsidian-img-opt --vault path/to/vault\n\n")
		fmt.Fprintf(os.Stderr, "Flags:\n")
		flag.PrintDefaults()
	}

	flag.Parse()

	if cfg.VaultPath == "" && cfg.FilePath == "" {
		// Default to current directory if neither specified
		cwd, err := os.Getwd()
		if err == nil {
			cfg.VaultPath = cwd
		} else {
			return nil, fmt.Errorf("either --vault or --file must be specified")
		}
	}

	if cfg.Quality < 1 || cfg.Quality > 100 {
		return nil, fmt.Errorf("quality must be between 1 and 100, got %d", cfg.Quality)
	}

	if cfg.MaxColors < 2 || cfg.MaxColors > 256 {
		return nil, fmt.Errorf("gif-colors must be between 2 and 256, got %d", cfg.MaxColors)
	}

	if cfg.VaultPath != "" {
		abs, err := filepath.Abs(cfg.VaultPath)
		if err != nil {
			return nil, fmt.Errorf("invalid vault path: %w", err)
		}
		cfg.VaultPath = abs
	}

	if cfg.FilePath != "" {
		abs, err := filepath.Abs(cfg.FilePath)
		if err != nil {
			return nil, fmt.Errorf("invalid file path: %w", err)
		}
		cfg.FilePath = abs
	}

	return cfg, nil
}
