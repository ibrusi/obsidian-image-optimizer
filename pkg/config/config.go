package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// GifMode selects how GIF images are processed.
type GifMode string

const (
	// GifModeAuto tries animated WebP first and falls back to GIF optimisation.
	GifModeAuto GifMode = "auto"
	// GifModeWebp converts GIFs to (animated) WebP only; on failure the original is kept.
	GifModeWebp GifMode = "webp"
	// GifModeOptimize keeps the GIF format and only recompresses it.
	GifModeOptimize GifMode = "optimize"
	// GifModeKeep leaves every GIF (static or animated) untouched.
	GifModeKeep GifMode = "keep"
)

// LinkFormat selects the syntax of rewritten remote image links.
type LinkFormat string

const (
	// LinkFormatMarkdown produces ![alt](attachments/image.webp).
	LinkFormatMarkdown LinkFormat = "markdown"
	// LinkFormatWikilink produces ![[attachments/image.webp|alt]].
	LinkFormatWikilink LinkFormat = "wikilink"
)

// OutputFormat selects how progress and the final summary are reported.
type OutputFormat string

const (
	// OutputText prints human-readable progress lines and a summary.
	OutputText OutputFormat = "text"
	// OutputJSON prints a single machine-readable JSON summary to stdout.
	OutputJSON OutputFormat = "json"
)

// Config holds all options for image downloading, conversion, and vault processing.
type Config struct {
	// VaultPath is the root of the Obsidian vault. It bounds which local files
	// may be touched and is required to safely retire optimised local originals.
	VaultPath string

	// FilePath is an optional single markdown file to process.
	FilePath string

	// AttachedDir is the folder where downloaded images are saved, relative to the note.
	AttachedDir string

	// BackupDir is the folder (inside the image's folder) where originals are
	// moved when they are replaced by an optimised version.
	BackupDir string

	// Quality is the lossy WebP quality (1-100).
	Quality int

	// GifMode specifies how GIFs should be processed.
	GifMode GifMode

	// GifDropFrames drops every second frame of long animations (pure-Go optimiser only).
	GifDropFrames bool

	// MaxColors is the maximum palette size for GIF optimisation (2-256).
	MaxColors int

	// GifLossy is the gifsicle --lossy level (0-200).
	GifLossy int

	// GifMaxWidth downscales GIFs wider than this many pixels; 0 disables resizing.
	GifMaxWidth int

	// OptimizeLocal also optimises existing local images referenced by notes.
	OptimizeLocal bool

	// KeepBackup moves replaced originals into BackupDir instead of deleting them.
	KeepBackup bool

	// LinkFormat controls the syntax of rewritten remote links.
	LinkFormat LinkFormat

	// DryRun reports planned changes without touching the disk or the network.
	DryRun bool

	// Verbose outputs detailed processing logs.
	Verbose bool

	// Output selects text or JSON reporting.
	Output OutputFormat

	// TimeoutSeconds is the HTTP timeout for a single image download.
	TimeoutSeconds int

	// ToolTimeoutSeconds bounds a single run of an external encoder.
	ToolTimeoutSeconds int

	// MaxDownloadMB caps the size of a single downloaded image.
	MaxDownloadMB int

	// MaxPixels caps the decoded size (width*height*frames) of images decoded in-process.
	MaxPixels int64

	// AllowPrivateHosts permits downloads from loopback, private and link-local addresses.
	AllowPrivateHosts bool

	// Concurrency is the number of images processed in parallel.
	Concurrency int

	// UserAgent is the HTTP User-Agent header for image downloads.
	UserAgent string
}

// DefaultConfig returns default configuration with recommended settings.
func DefaultConfig() *Config {
	return &Config{
		AttachedDir:        "attachments",
		BackupDir:          ".originals_backup",
		Quality:            40,
		GifMode:            GifModeAuto,
		GifDropFrames:      false,
		MaxColors:          128,
		GifLossy:           80,
		GifMaxWidth:        0,
		OptimizeLocal:      false,
		KeepBackup:         true,
		LinkFormat:         LinkFormatMarkdown,
		DryRun:             false,
		Verbose:            false,
		Output:             OutputText,
		TimeoutSeconds:     30,
		ToolTimeoutSeconds: 300,
		MaxDownloadMB:      50,
		MaxPixels:          100_000_000,
		AllowPrivateHosts:  false,
		Concurrency:        4,
		UserAgent:          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ObsidianImageOptimizer/1.1",
	}
}

// Parse parses command-line arguments (without the program name) into a
// validated Config. Usage and parse errors are written to stderr; a request
// for help is reported as flag.ErrHelp.
func Parse(args []string, stderr io.Writer) (*Config, error) {
	cfg := DefaultConfig()
	fs := newFlagSet(cfg, stderr)

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected arguments: %s", strings.Join(fs.Args(), " "))
	}

	if cfg.VaultPath == "" && cfg.FilePath == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("either --vault or --file must be specified: %w", err)
		}
		cfg.VaultPath = cwd
	}

	if err := cfg.absolutizePaths(); err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func newFlagSet(cfg *Config, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("obsidian-img-opt", flag.ContinueOnError)
	fs.SetOutput(stderr)

	fs.StringVar(&cfg.VaultPath, "vault", "", "Path to the Obsidian vault (processed recursively, or used as the root for --file)")
	fs.StringVar(&cfg.VaultPath, "dir", "", "Alias for --vault")
	fs.StringVar(&cfg.FilePath, "file", "", "Path to a single markdown file to process")
	fs.StringVar(&cfg.AttachedDir, "attached-dir", cfg.AttachedDir, "Folder for downloaded images, relative to the note")
	fs.StringVar(&cfg.AttachedDir, "attachments", cfg.AttachedDir, "Alias for --attached-dir")
	fs.StringVar(&cfg.BackupDir, "backup-dir", cfg.BackupDir, "Folder (inside the image folder) for replaced originals")
	fs.StringVar(&cfg.BackupDir, "backup", cfg.BackupDir, "Alias for --backup-dir")
	fs.IntVar(&cfg.Quality, "quality", cfg.Quality, "WebP lossy compression quality (1-100)")
	fs.Var(enumValue[GifMode]{&cfg.GifMode, gifModes}, "gif-mode", "GIF processing mode: auto | webp | optimize | keep")
	fs.IntVar(&cfg.GifLossy, "gif-lossy", cfg.GifLossy, "Gifsicle lossy factor for GIF compression (0-200)")
	fs.BoolVar(&cfg.GifDropFrames, "gif-drop-frames", cfg.GifDropFrames, "Drop every 2nd frame of long animated GIFs (built-in optimiser)")
	fs.IntVar(&cfg.MaxColors, "gif-colors", cfg.MaxColors, "Maximum palette colors for GIF optimisation (2-256)")
	fs.IntVar(&cfg.GifMaxWidth, "gif-max-width", cfg.GifMaxWidth, "Downscale GIFs wider than this many pixels (0 = keep size)")
	fs.BoolVar(&cfg.OptimizeLocal, "optimize-local", cfg.OptimizeLocal, "Also optimise existing local JPG/PNG/GIF/BMP/TIFF images referenced by notes")
	fs.BoolVar(&cfg.KeepBackup, "keep-backup", cfg.KeepBackup, "Move replaced originals into --backup-dir instead of deleting them")
	fs.Var(enumValue[LinkFormat]{&cfg.LinkFormat, linkFormats}, "link-format", "Link format for rewritten remote images: markdown | wikilink")
	fs.BoolVar(&cfg.DryRun, "dry-run", cfg.DryRun, "Show planned changes without downloading or writing anything")
	fs.BoolVar(&cfg.Verbose, "verbose", cfg.Verbose, "Enable verbose debug logs")
	fs.Var(enumValue[OutputFormat]{&cfg.Output, outputFormats}, "output", "Report format: text | json")
	fs.IntVar(&cfg.TimeoutSeconds, "timeout", cfg.TimeoutSeconds, "HTTP download timeout in seconds")
	fs.IntVar(&cfg.ToolTimeoutSeconds, "tool-timeout", cfg.ToolTimeoutSeconds, "Timeout in seconds for a single external encoder run")
	fs.IntVar(&cfg.MaxDownloadMB, "max-download-mb", cfg.MaxDownloadMB, "Maximum size of a single downloaded image in MB")
	fs.Int64Var(&cfg.MaxPixels, "max-pixels", cfg.MaxPixels, "Maximum decoded pixels (width*height*frames) for in-process decoding")
	fs.BoolVar(&cfg.AllowPrivateHosts, "allow-private-hosts", cfg.AllowPrivateHosts, "Allow downloads from loopback, private and link-local addresses")
	fs.IntVar(&cfg.Concurrency, "concurrency", cfg.Concurrency, "Number of images processed in parallel (1-64)")

	fs.Usage = func() {
		out := fs.Output()
		fmt.Fprintf(out, "Obsidian Image Optimizer (Go)\n")
		fmt.Fprintf(out, "Downloads remote images from Obsidian notes, converts them to WebP (default quality 40),\n")
		fmt.Fprintf(out, "optimizes GIFs, keeps the originals and updates markdown links.\n\n")
		fmt.Fprintf(out, "Usage:\n")
		fmt.Fprintf(out, "  obsidian-img-opt --vault path/to/vault [--file path/to/note.md] [flags]\n\n")
		fmt.Fprintf(out, "Flags:\n")
		fs.PrintDefaults()
	}
	return fs
}

func (c *Config) absolutizePaths() error {
	if c.VaultPath != "" {
		abs, err := filepath.Abs(c.VaultPath)
		if err != nil {
			return fmt.Errorf("invalid vault path: %w", err)
		}
		c.VaultPath = abs
	}
	if c.FilePath != "" {
		abs, err := filepath.Abs(c.FilePath)
		if err != nil {
			return fmt.Errorf("invalid file path: %w", err)
		}
		c.FilePath = abs
	}
	return nil
}

// Validate checks option ranges, enum values and folder names.
// It does not touch the filesystem.
func (c *Config) Validate() error {
	var errs []error
	check := func(ok bool, format string, args ...any) {
		if !ok {
			errs = append(errs, fmt.Errorf(format, args...))
		}
	}

	check(c.VaultPath != "" || c.FilePath != "", "either --vault or --file must be specified")
	check(c.Quality >= 1 && c.Quality <= 100, "quality must be between 1 and 100, got %d", c.Quality)
	check(c.MaxColors >= 2 && c.MaxColors <= 256, "gif-colors must be between 2 and 256, got %d", c.MaxColors)
	check(c.GifLossy >= 0 && c.GifLossy <= 200, "gif-lossy must be between 0 and 200, got %d", c.GifLossy)
	check(c.GifMaxWidth >= 0, "gif-max-width must not be negative, got %d", c.GifMaxWidth)
	check(c.TimeoutSeconds > 0, "timeout must be positive, got %d", c.TimeoutSeconds)
	check(c.ToolTimeoutSeconds > 0, "tool-timeout must be positive, got %d", c.ToolTimeoutSeconds)
	check(c.MaxDownloadMB > 0, "max-download-mb must be positive, got %d", c.MaxDownloadMB)
	check(c.MaxPixels > 0, "max-pixels must be positive, got %d", c.MaxPixels)
	check(c.Concurrency >= 1 && c.Concurrency <= 64, "concurrency must be between 1 and 64, got %d", c.Concurrency)
	check(slices.Contains(gifModes, c.GifMode), "unknown gif-mode %q", c.GifMode)
	check(slices.Contains(linkFormats, c.LinkFormat), "unknown link-format %q", c.LinkFormat)
	check(slices.Contains(outputFormats, c.Output), "unknown output %q", c.Output)

	if err := validateFolder("attached-dir", c.AttachedDir); err != nil {
		errs = append(errs, err)
	}
	if err := validateFolder("backup-dir", c.BackupDir); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// validateFolder rejects empty, absolute and escaping (../) folder names, so
// the tool can never write outside the folder of the note or image.
func validateFolder(flagName, dir string) error {
	if dir == "" {
		return fmt.Errorf("%s must not be empty", flagName)
	}
	if !filepath.IsLocal(dir) {
		return fmt.Errorf("%s must be a relative path inside the note folder, got %q", flagName, dir)
	}
	if strings.ContainsAny(dir, "|[]#^") {
		return fmt.Errorf("%s must not contain characters that break Obsidian links (|[]#^), got %q", flagName, dir)
	}
	return nil
}

// MaxDownloadBytes returns the download size limit in bytes.
func (c *Config) MaxDownloadBytes() int64 {
	return int64(c.MaxDownloadMB) << 20
}

var (
	gifModes      = []GifMode{GifModeAuto, GifModeWebp, GifModeOptimize, GifModeKeep}
	linkFormats   = []LinkFormat{LinkFormatMarkdown, LinkFormatWikilink}
	outputFormats = []OutputFormat{OutputText, OutputJSON}
)

// enumValue is a flag.Value that only accepts one of the allowed values.
type enumValue[T ~string] struct {
	target  *T
	allowed []T
}

func (e enumValue[T]) String() string {
	if e.target == nil {
		return ""
	}
	return string(*e.target)
}

func (e enumValue[T]) Set(s string) error {
	v := T(strings.ToLower(strings.TrimSpace(s)))
	if !slices.Contains(e.allowed, v) {
		names := make([]string, len(e.allowed))
		for i, a := range e.allowed {
			names[i] = string(a)
		}
		return fmt.Errorf("must be one of: %s", strings.Join(names, ", "))
	}
	*e.target = v
	return nil
}
