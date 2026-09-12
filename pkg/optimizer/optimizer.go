package optimizer

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"obsidian-image-optimizer/pkg/config"
)

// OptimizeResult contains statistics and paths for the optimized image.
type OptimizeResult struct {
	OriginalPath   string
	FinalPath      string
	RelativePath   string
	OriginalSize   int64
	FinalSize      int64
	SavedBytes     int64
	SavingsPercent float64
	Format         string
	KeptOriginal   bool
}

// Optimize processes an image: backs it up, converts/optimizes, compares size, and resolves winner.
func Optimize(srcFile, attachedDir, baseDir string, cfg *config.Config) (*OptimizeResult, error) {
	if err := os.MkdirAll(attachedDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create attached directory: %w", err)
	}

	backupDir := filepath.Join(attachedDir, cfg.BackupDir)
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create backup directory: %w", err)
	}

	fileName := filepath.Base(srcFile)
	ext := strings.ToLower(filepath.Ext(fileName))
	baseName := strings.TrimSuffix(fileName, ext)

	// Step 1: Backup original image
	backupPath := filepath.Join(backupDir, fileName)
	if err := copyFile(srcFile, backupPath); err != nil {
		return nil, fmt.Errorf("failed to backup original file %s: %w", srcFile, err)
	}

	origInfo, err := os.Stat(backupPath)
	if err != nil {
		return nil, fmt.Errorf("failed to stat backup file: %w", err)
	}
	origSize := origInfo.Size()

	var candidatePath string
	var candidateFormat string

	// Step 2: Convert/Compress
	if ext == ".gif" {
		gifRes, err := ProcessGIF(backupPath, attachedDir, cfg)
		if err != nil {
			// On error, fallback to keeping original
			if cfg.Verbose {
				fmt.Printf("[Optimizer] GIF processing error (%v), keeping original\n", err)
			}
			return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
		}

		if gifRes.IsStatic {
			// Static GIF -> convert to WebP
			candidatePath, err = encodeToWebp(backupPath, attachedDir, baseName, cfg.Quality)
			if err != nil {
				return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
			}
			candidateFormat = "webp"
		} else {
			candidatePath = gifRes.CandidatePath
			if gifRes.ConvertedToWebp {
				candidateFormat = "webp"
			} else {
				candidateFormat = "gif"
			}
		}
	} else if ext == ".svg" {
		// Vector SVG is usually already optimal for text/diagrams
		return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
	} else {
		// JPEG, PNG, WebP, BMP, TIFF -> convert to WebP with configured quality
		var err error
		candidatePath, err = encodeToWebp(backupPath, attachedDir, baseName, cfg.Quality)
		if err != nil {
			if cfg.Verbose {
				fmt.Printf("[Optimizer] WebP encode error for %s: %v, keeping original\n", fileName, err)
			}
			return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
		}
		candidateFormat = "webp"
	}

	// Step 3: Size comparison
	candInfo, err := os.Stat(candidatePath)
	if err != nil {
		return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
	}
	candSize := candInfo.Size()

	// Condition: "если размер новой картинки уменьшился по сравнению со старым, то оставляем новую,
	// если нет, исходник не удаляем, удаляем новую."
	if candSize < origSize {
		// Candidate is lighter -> keep candidate!
		finalPath := candidatePath
		relPath, _ := filepath.Rel(baseDir, finalPath)
		// Ensure forward slashes for markdown compatibility
		relPath = filepath.ToSlash(relPath)

		savedBytes := origSize - candSize
		savingsPct := float64(savedBytes) / float64(origSize) * 100

		// Clean up srcFile if it was a temporary downloaded file
		if srcFile != backupPath && srcFile != candidatePath {
			_ = os.Remove(srcFile)
		}

		return &OptimizeResult{
			OriginalPath:   backupPath,
			FinalPath:      finalPath,
			RelativePath:   relPath,
			OriginalSize:   origSize,
			FinalSize:      candSize,
			SavedBytes:     savedBytes,
			SavingsPercent: savingsPct,
			Format:         candidateFormat,
			KeptOriginal:   false,
		}, nil
	}

	// Candidate is larger or equal -> delete candidate, keep original!
	_ = os.Remove(candidatePath)
	return fallbackToOriginal(backupPath, attachedDir, baseDir, fileName, origSize, ext)
}

// encodeToWebp decodes standard images and encodes them into lossy WebP at specified quality.
func encodeToWebp(srcPath, destDir, baseName string, quality int) (string, error) {
	targetPath := filepath.Join(destDir, baseName+".webp")

	// 1. If cwebp command is installed on the system, use it directly (matches user's bash workflow)
	if cwebpPath, err := exec.LookPath("cwebp"); err == nil {
		cmd := exec.Command(cwebpPath, "-q", fmt.Sprintf("%d", quality), "-m", "6", "-metadata", "none", srcPath, "-o", targetPath)
		if err := cmd.Run(); err == nil {
			if info, statErr := os.Stat(targetPath); statErr == nil && info.Size() > 0 {
				return targetPath, nil
			}
		}
	}

	// 2. Fallback to ffmpeg
	if ffmpegPath, err := exec.LookPath("ffmpeg"); err == nil {
		cmd := exec.Command(ffmpegPath, "-y", "-nostdin", "-i", srcPath, "-q:v", fmt.Sprintf("%d", quality), targetPath)
		if err := cmd.Run(); err == nil {
			if info, statErr := os.Stat(targetPath); statErr == nil && info.Size() > 0 {
				return targetPath, nil
			}
		}
	}

	return "", fmt.Errorf("neither 'cwebp' nor 'ffmpeg' available to encode %s to WebP. Install with: sudo apt install webp ffmpeg", srcPath)
}

// fallbackToOriginal restores original file into attachedDir.
func fallbackToOriginal(backupPath, attachedDir, baseDir, fileName string, origSize int64, ext string) (*OptimizeResult, error) {
	finalPath := filepath.Join(attachedDir, fileName)
	if backupPath != finalPath {
		if err := copyFile(backupPath, finalPath); err != nil {
			return nil, fmt.Errorf("failed to copy original file to destination: %w", err)
		}
	}

	relPath, _ := filepath.Rel(baseDir, finalPath)
	relPath = filepath.ToSlash(relPath)

	return &OptimizeResult{
		OriginalPath:   backupPath,
		FinalPath:      finalPath,
		RelativePath:   relPath,
		OriginalSize:   origSize,
		FinalSize:      origSize,
		SavedBytes:     0,
		SavingsPercent: 0,
		Format:         strings.TrimPrefix(ext, "."),
		KeptOriginal:   true,
	}, nil
}

// copyFile copies a file from src to dst.
func copyFile(src, dst string) error {
	if src == dst {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
