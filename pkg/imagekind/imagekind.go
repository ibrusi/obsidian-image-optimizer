// Package imagekind identifies image formats by their content (magic bytes),
// which is the only trustworthy signal: file extensions and Content-Type
// headers are hints that are frequently wrong on the web.
package imagekind

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Kind is a supported image format.
type Kind string

const (
	Unknown Kind = ""
	JPEG    Kind = "jpeg"
	PNG     Kind = "png"
	GIF     Kind = "gif"
	WebP    Kind = "webp"
	BMP     Kind = "bmp"
	TIFF    Kind = "tiff"
	SVG     Kind = "svg"
)

// SniffLen is the number of leading bytes Sniff needs to recognise every kind.
const SniffLen = 4096

// Ext returns the canonical file extension (with leading dot) for the kind.
func (k Kind) Ext() string {
	switch k {
	case JPEG:
		return ".jpg"
	case Unknown:
		return ""
	default:
		return "." + string(k)
	}
}

// Sniff detects a raster image format from its magic bytes.
// SVG is never reported here because it is plain text; see SniffSVG.
func Sniff(head []byte) Kind {
	switch {
	case len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF:
		return JPEG
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return PNG
	case bytes.HasPrefix(head, []byte("GIF87a")), bytes.HasPrefix(head, []byte("GIF89a")):
		return GIF
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return WebP
	case bytes.HasPrefix(head, []byte("BM")) && len(head) >= 14:
		return BMP
	case bytes.HasPrefix(head, []byte("II*\x00")), bytes.HasPrefix(head, []byte("MM\x00*")):
		return TIFF
	}
	return Unknown
}

// SniffSVG reports whether head looks like an SVG document.
func SniffSVG(head []byte) bool {
	return bytes.Contains(bytes.ToLower(head), []byte("<svg"))
}

// SniffFile reads the beginning of the file at path and detects its raster kind.
func SniffFile(path string) (Kind, error) {
	f, err := os.Open(path)
	if err != nil {
		return Unknown, err
	}
	defer f.Close()

	head := make([]byte, 32)
	n, err := io.ReadFull(f, head)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return Unknown, err
	}
	return Sniff(head[:n]), nil
}

// IsCompressibleExt reports whether a local file with this name is a candidate
// for optimisation (raster formats other than WebP).
func IsCompressibleExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff":
		return true
	}
	return false
}

// IsImageExt reports whether the file name has any image extension known to Obsidian.
func IsImageExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".webp", ".svg", ".avif":
		return true
	}
	return IsCompressibleExt(name)
}
