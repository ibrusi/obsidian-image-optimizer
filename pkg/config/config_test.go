package config

import (
	"testing"
)

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()

	if cfg.AttachedDir != "attachments" {
		t.Errorf("expected AttachedDir to be 'attachments', got %q", cfg.AttachedDir)
	}

	if cfg.Quality != 40 {
		t.Errorf("expected Quality to be 40, got %d", cfg.Quality)
	}

	if cfg.BackupDir != ".originals_backup" {
		t.Errorf("expected BackupDir to be '.originals_backup', got %q", cfg.BackupDir)
	}
}
