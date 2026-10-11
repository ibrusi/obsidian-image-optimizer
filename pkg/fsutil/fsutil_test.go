package fsutil

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestCommitUniqueNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "pic.webp"), "user file")
	writeFile(t, filepath.Join(dir, "pic-1.webp"), "another user file")

	tmp, err := TempSibling(dir, ".webp")
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, tmp, "new content")

	final, err := CommitUnique(tmp, dir, "pic", ".webp")
	if err != nil {
		t.Fatalf("CommitUnique: %v", err)
	}
	if filepath.Base(final) != "pic-2.webp" {
		t.Errorf("expected pic-2.webp, got %s", filepath.Base(final))
	}
	if readFile(t, filepath.Join(dir, "pic.webp")) != "user file" {
		t.Error("existing pic.webp was modified")
	}
	if readFile(t, filepath.Join(dir, "pic-1.webp")) != "another user file" {
		t.Error("existing pic-1.webp was modified")
	}
	if readFile(t, final) != "new content" {
		t.Error("committed file has wrong content")
	}
	if _, err := os.Stat(tmp); !errors.Is(err, fs.ErrNotExist) {
		t.Error("temp file must be gone after commit")
	}
}

func TestCommitNoClobberReportsExisting(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	writeFile(t, src, "a")
	writeFile(t, dst, "b")

	if err := CommitNoClobber(src, dst); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("expected fs.ErrExist, got %v", err)
	}
	if readFile(t, dst) != "b" {
		t.Error("destination was overwritten")
	}
}

func TestTempSiblingKeepsExtensionAndPermissions(t *testing.T) {
	dir := t.TempDir()
	tmp, err := TempSibling(dir, ".webp")
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(tmp)
	if !strings.HasPrefix(base, TempPrefix) || !strings.HasSuffix(base, ".webp") {
		t.Errorf("unexpected temp name %s", base)
	}
	info, err := os.Stat(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != FilePerm {
		t.Errorf("expected %v, got %v", FilePerm, info.Mode().Perm())
	}
}

func TestWriteFileAtomicPreservesPermissions(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.md")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := WriteFileAtomic(path, []byte("new"), 0o600); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	if readFile(t, path) != "new" {
		t.Error("content not replaced")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("permissions changed to %v", info.Mode().Perm())
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestIsWithin(t *testing.T) {
	root := filepath.FromSlash("/vault")
	tests := []struct {
		path string
		want bool
	}{
		{"/vault", true},
		{"/vault/a/b.png", true},
		{"/vault/../etc/passwd", false},
		{"/vaultx/a.png", false},
		{"/other", false},
	}
	for _, tt := range tests {
		if got := IsWithin(root, filepath.Clean(filepath.FromSlash(tt.path))); got != tt.want {
			t.Errorf("IsWithin(%q) = %v, want %v", tt.path, got, tt.want)
		}
	}
}
