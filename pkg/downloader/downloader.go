package downloader

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	safeFilenameRe = regexp.MustCompile(`[^a-zA-Z0-9_\-\.]`)
)

// Downloader handles fetching remote images and saving them locally.
type Downloader struct {
	client    *http.Client
	userAgent string
}

// NewDownloader creates a new Downloader with custom timeout and user agent.
func NewDownloader(timeoutSeconds int, userAgent string) *Downloader {
	return &Downloader{
		client: &http.Client{
			Timeout: time.Duration(timeoutSeconds) * time.Second,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 10 {
					return fmt.Errorf("stopped after 10 redirects")
				}
				return nil
			},
		},
		userAgent: userAgent,
	}
}

// DownloadedFile stores details about the fetched image.
type DownloadedFile struct {
	URL        string
	LocalPath  string
	Filename   string
	Ext        string
	Size       int64
	IsFromDisk bool
}

// Download fetches an image from rawURL and saves it to destDir.
func (d *Downloader) Download(ctx context.Context, rawURL string, destDir string) (*DownloadedFile, error) {
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create directory %s: %w", destDir, err)
	}

	parsedURL, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid url %s: %w", rawURL, err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request for %s: %w", rawURL, err)
	}
	req.Header.Set("User-Agent", d.userAgent)
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")

	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download error for %s: %w", rawURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed for %s: HTTP %d %s", rawURL, resp.StatusCode, resp.Status)
	}

	// Sniff the beginning of body to reliably determine content type
	headerBuf := make([]byte, 512)
	n, readErr := io.ReadFull(resp.Body, headerBuf)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		return nil, fmt.Errorf("failed to read response header for %s: %w", rawURL, readErr)
	}
	sniffed := headerBuf[:n]

	ext := determineExtension(parsedURL.Path, resp.Header.Get("Content-Type"), sniffed)
	baseName := generateBaseName(parsedURL, rawURL)
	fileName := fmt.Sprintf("%s%s", baseName, ext)
	targetPath := filepath.Join(destDir, fileName)

	// Write to a temporary file first, then atomically rename
	tmpPath := targetPath + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file %s: %w", tmpPath, err)
	}

	var written int64
	if n > 0 {
		w, wErr := f.Write(sniffed)
		if wErr != nil {
			f.Close()
			os.Remove(tmpPath)
			return nil, fmt.Errorf("failed writing sniffed bytes: %w", wErr)
		}
		written += int64(w)
	}

	w, copyErr := io.Copy(f, resp.Body)
	f.Close()
	if copyErr != nil {
		os.Remove(tmpPath)
		return nil, fmt.Errorf("failed streaming body for %s: %w", rawURL, copyErr)
	}
	written += w

	if err := os.Rename(tmpPath, targetPath); err != nil {
		os.Remove(tmpPath)
		return nil, fmt.Errorf("failed to rename %s to %s: %w", tmpPath, targetPath, err)
	}

	return &DownloadedFile{
		URL:       rawURL,
		LocalPath: targetPath,
		Filename:  fileName,
		Ext:       ext,
		Size:      written,
	}, nil
}

// generateBaseName creates a clean, collision-free filename from URL.
func generateBaseName(parsedURL *url.URL, rawURL string) string {
	rawPath := parsedURL.Path
	cleanName := filepath.Base(rawPath)
	cleanName = strings.TrimSuffix(cleanName, filepath.Ext(cleanName))
	cleanName = safeFilenameRe.ReplaceAllString(cleanName, "_")
	cleanName = strings.Trim(cleanName, "_")

	// If the name is too short, empty, or generic
	if len(cleanName) < 3 || strings.EqualFold(cleanName, "image") || strings.EqualFold(cleanName, "download") {
		cleanName = "img"
	}

	// Limit length
	if len(cleanName) > 40 {
		cleanName = cleanName[:40]
	}

	// Append MD5 hash of raw URL (first 8 hex digits) to prevent collisions
	hash := md5.Sum([]byte(rawURL))
	shortHash := hex.EncodeToString(hash[:])[:8]

	return fmt.Sprintf("%s_%s", cleanName, shortHash)
}

// determineExtension determines file extension (.jpg, .png, .gif, .webp) from URL path, Content-Type, or sniffed bytes.
func determineExtension(urlPath, contentType string, sniffedBytes []byte) string {
	// 1. Check URL path extension
	if ext := strings.ToLower(filepath.Ext(urlPath)); ext != "" {
		switch ext {
		case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".svg":
			if ext == ".jpeg" {
				return ".jpg"
			}
			return ext
		}
	}

	// 2. Check Content-Type header
	if contentType != "" {
		mediaType, _, _ := mime.ParseMediaType(contentType)
		switch strings.ToLower(mediaType) {
		case "image/jpeg":
			return ".jpg"
		case "image/png":
			return ".png"
		case "image/webp":
			return ".webp"
		case "image/gif":
			return ".gif"
		case "image/bmp", "image/x-ms-bmp":
			return ".bmp"
		case "image/tiff":
			return ".tiff"
		case "image/svg+xml":
			return ".svg"
		}
	}

	// 3. Sniff magic bytes
	if len(sniffedBytes) > 0 {
		ct := http.DetectContentType(sniffedBytes)
		switch ct {
		case "image/jpeg":
			return ".jpg"
		case "image/png":
			return ".png"
		case "image/gif":
			return ".gif"
		case "image/webp":
			return ".webp"
		}

		// Additional magic bytes check
		if len(sniffedBytes) >= 4 {
			if string(sniffedBytes[:4]) == "RIFF" && len(sniffedBytes) >= 12 && string(sniffedBytes[8:12]) == "WEBP" {
				return ".webp"
			}
			if string(sniffedBytes[:3]) == "GIF" {
				return ".gif"
			}
			if sniffedBytes[0] == 0x89 && string(sniffedBytes[1:4]) == "PNG" {
				return ".png"
			}
			if sniffedBytes[0] == 0xFF && sniffedBytes[1] == 0xD8 {
				return ".jpg"
			}
		}
	}

	return ".jpg" // Default fallback
}
