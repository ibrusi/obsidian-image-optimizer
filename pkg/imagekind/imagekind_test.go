package imagekind

import "testing"

func TestSniff(t *testing.T) {
	tests := []struct {
		name string
		head string
		want Kind
	}{
		{"jpeg", "\xFF\xD8\xFF\xE0\x00\x10JFIF", JPEG},
		{"png", "\x89PNG\r\n\x1a\n\x00\x00", PNG},
		{"gif89a", "GIF89a\x01\x00", GIF},
		{"gif87a", "GIF87a\x01\x00", GIF},
		{"webp", "RIFF\x00\x00\x00\x00WEBPVP8 ", WebP},
		{"bmp", "BM\x00\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00", BMP},
		{"tiff le", "II*\x00\x08\x00", TIFF},
		{"tiff be", "MM\x00*\x00\x08", TIFF},
		{"html", "<html><body>denied</body></html>", Unknown},
		{"svg is text", "<svg xmlns='http://www.w3.org/2000/svg'/>", Unknown},
		{"empty", "", Unknown},
		{"riff but not webp", "RIFF\x00\x00\x00\x00WAVEfmt ", Unknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Sniff([]byte(tt.head)); got != tt.want {
				t.Errorf("Sniff = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSniffSVG(t *testing.T) {
	if !SniffSVG([]byte(`<?xml version="1.0"?><!-- c --><SVG width="1">`)) {
		t.Error("expected SVG to be detected case-insensitively")
	}
	if SniffSVG([]byte("<html></html>")) {
		t.Error("HTML must not be detected as SVG")
	}
}

func TestExtensions(t *testing.T) {
	if JPEG.Ext() != ".jpg" || WebP.Ext() != ".webp" || Unknown.Ext() != "" {
		t.Error("unexpected canonical extensions")
	}
	for _, name := range []string{"a.JPG", "b.jpeg", "c.png", "d.gif", "e.bmp", "f.tif", "g.tiff"} {
		if !IsCompressibleExt(name) {
			t.Errorf("%s must be compressible", name)
		}
	}
	for _, name := range []string{"a.webp", "b.svg", "c.md"} {
		if IsCompressibleExt(name) {
			t.Errorf("%s must not be compressible", name)
		}
	}
	if !IsImageExt("a.webp") || IsImageExt("a.md") {
		t.Error("IsImageExt mismatch")
	}
}
