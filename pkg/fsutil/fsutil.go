// Package fsutil provides file operations that never clobber or silently lose
// user data: atomic writes, unique-name commits and temp files that live next
// to their final destination (so the final rename stays on one filesystem).
package fsutil

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// TempPrefix marks every temporary file this tool creates.
const TempPrefix = ".imgopt-"

// maxNameAttempts bounds the search for a free file name.
const maxNameAttempts = 10000

// WriteFileAtomic writes data to a sibling temp file and renames it over path,
// so readers observe either the old or the new content, never a partial file.
func WriteFileAtomic(path string, data []byte, perm fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), TempPrefix+"*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// FilePerm is the permission of files this tool publishes into the vault.
const FilePerm fs.FileMode = 0o644

// TempSibling creates an empty temp file in dir whose name ends with ext
// (external encoders such as ffmpeg infer the output format from it) and
// returns its path. The caller owns the file and must remove it.
func TempSibling(dir, ext string) (string, error) {
	f, err := CreateTemp(dir, ext)
	if err != nil {
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// CreateTemp creates and opens a temp file in dir whose name ends with ext.
// Unlike os.CreateTemp it uses FilePerm, because the file is meant to be
// published into the vault later.
func CreateTemp(dir, ext string) (*os.File, error) {
	f, err := os.CreateTemp(dir, TempPrefix+"*"+ext)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(FilePerm); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, err
	}
	return f, nil
}

// CommitNoClobber moves src to dst and fails with an error wrapping
// fs.ErrExist if dst already exists. src and dst must be on one filesystem.
func CommitNoClobber(src, dst string) error {
	err := os.Link(src, dst)
	if err == nil {
		return os.Remove(src)
	}
	if errors.Is(err, fs.ErrExist) {
		return err
	}
	// Hard links are unsupported on some filesystems (FAT/exFAT, some network
	// mounts). Fall back to check-then-rename; the window between Lstat and
	// Rename is tiny, and only another writer racing for the same new name
	// could hit it.
	if _, statErr := os.Lstat(dst); statErr == nil {
		return &fs.PathError{Op: "commit", Path: dst, Err: fs.ErrExist}
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return statErr
	}
	return os.Rename(src, dst)
}

// CommitUnique moves src into dir as stem+ext, or stem-N+ext when that name is
// taken, and returns the final path. Existing files are never overwritten.
func CommitUnique(src, dir, stem, ext string) (string, error) {
	for i := 0; i < maxNameAttempts; i++ {
		name := stem + ext
		if i > 0 {
			name = fmt.Sprintf("%s-%d%s", stem, i, ext)
		}
		dst := filepath.Join(dir, name)
		err := CommitNoClobber(src, dst)
		if err == nil {
			return dst, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", err
		}
	}
	return "", fmt.Errorf("no free file name for %s%s in %s", stem, ext, dir)
}

// IsWithin reports whether path is root itself or lies inside root.
// Both paths must be absolute and clean.
func IsWithin(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel == "." || filepath.IsLocal(rel)
}
