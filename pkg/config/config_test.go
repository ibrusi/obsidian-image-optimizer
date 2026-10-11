package config

import (
	"errors"
	"flag"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Quality != 40 {
		t.Errorf("expected default quality 40, got %d", cfg.Quality)
	}
	if cfg.AttachedDir != "attachments" {
		t.Errorf("expected default attached dir 'attachments', got %q", cfg.AttachedDir)
	}
	if !cfg.KeepBackup {
		t.Error("expected KeepBackup to default to true")
	}
	if cfg.AllowPrivateHosts {
		t.Error("expected private hosts to be blocked by default")
	}
	cfg.VaultPath = "/vault"
	if err := cfg.Validate(); err != nil {
		t.Errorf("default config must be valid: %v", err)
	}
}

func TestParse(t *testing.T) {
	vault := t.TempDir()
	cfg, err := Parse([]string{
		"--vault", vault,
		"--file", filepath.Join(vault, "note.md"),
		"--gif-mode", "OPTIMIZE",
		"--link-format=wikilink",
		"--keep-backup=false",
		"--output", "json",
		"--attachments", "assets/img",
		"--concurrency", "8",
	}, io.Discard)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}

	if cfg.GifMode != GifModeOptimize {
		t.Errorf("gif mode: got %q", cfg.GifMode)
	}
	if cfg.LinkFormat != LinkFormatWikilink {
		t.Errorf("link format: got %q", cfg.LinkFormat)
	}
	if cfg.KeepBackup {
		t.Error("--keep-backup=false must disable backups")
	}
	if cfg.Output != OutputJSON {
		t.Errorf("output: got %q", cfg.Output)
	}
	if cfg.AttachedDir != "assets/img" {
		t.Errorf("attached dir alias: got %q", cfg.AttachedDir)
	}
	if cfg.Concurrency != 8 {
		t.Errorf("concurrency: got %d", cfg.Concurrency)
	}
	if !filepath.IsAbs(cfg.FilePath) || !filepath.IsAbs(cfg.VaultPath) {
		t.Errorf("paths must be absolute: %q, %q", cfg.VaultPath, cfg.FilePath)
	}
}

func TestParseDefaultsToWorkingDirectory(t *testing.T) {
	cfg, err := Parse(nil, io.Discard)
	if err != nil {
		t.Fatalf("Parse failed: %v", err)
	}
	if cfg.VaultPath == "" {
		t.Error("vault must default to the working directory")
	}
}

func TestParseErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"unknown gif mode", []string{"--gif-mode", "fast"}, "must be one of"},
		{"unknown link format", []string{"--link-format", "html"}, "must be one of"},
		{"quality too high", []string{"--quality", "101"}, "quality"},
		{"quality zero", []string{"--quality", "0"}, "quality"},
		{"colors", []string{"--gif-colors", "1"}, "gif-colors"},
		{"lossy", []string{"--gif-lossy", "500"}, "gif-lossy"},
		{"timeout", []string{"--timeout", "0"}, "timeout"},
		{"download limit", []string{"--max-download-mb", "0"}, "max-download-mb"},
		{"concurrency", []string{"--concurrency", "0"}, "concurrency"},
		{"negative width", []string{"--gif-max-width", "-1"}, "gif-max-width"},
		{"traversal attached", []string{"--attached-dir", "../outside"}, "attached-dir"},
		{"absolute attached", []string{"--attached-dir", "/etc"}, "attached-dir"},
		{"empty attached", []string{"--attached-dir", ""}, "attached-dir"},
		{"traversal backup", []string{"--backup-dir", "../../x"}, "backup-dir"},
		{"link breaking chars", []string{"--attached-dir", "a|b"}, "attached-dir"},
		{"positional args", []string{"note.md"}, "unexpected arguments"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := append([]string{"--vault", t.TempDir()}, tt.args...)
			_, err := Parse(args, io.Discard)
			if err == nil {
				t.Fatalf("expected an error for %v", tt.args)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error %q does not mention %q", err, tt.want)
			}
		})
	}
}

func TestParseHelp(t *testing.T) {
	var out strings.Builder
	_, err := Parse([]string{"-h"}, &out)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("expected flag.ErrHelp, got %v", err)
	}
	if !strings.Contains(out.String(), "--allow-private-hosts") && !strings.Contains(out.String(), "-allow-private-hosts") {
		t.Errorf("usage must list flags, got:\n%s", out.String())
	}
}

func TestMaxDownloadBytes(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxDownloadMB = 3
	if got := cfg.MaxDownloadBytes(); got != 3<<20 {
		t.Errorf("got %d", got)
	}
}
