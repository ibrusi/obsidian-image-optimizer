package imageinfo

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"testing"
)

// jpegWithOrientation encodes a w*h JPEG and injects an EXIF APP1 segment
// carrying the given orientation, using the given byte order.
func jpegWithOrientation(t *testing.T, w, h, orientation int, order binary.ByteOrder) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil); err != nil {
		t.Fatal(err)
	}
	return injectOrientation(buf.Bytes(), orientation, order)
}

func injectOrientation(jpg []byte, orientation int, order binary.ByteOrder) []byte {
	tiff := make([]byte, 8+2+12+4)
	if order == binary.LittleEndian {
		copy(tiff, "II")
	} else {
		copy(tiff, "MM")
	}
	order.PutUint16(tiff[2:], 42)
	order.PutUint32(tiff[4:], 8)
	order.PutUint16(tiff[8:], 1)       // one IFD entry
	order.PutUint16(tiff[10:], 0x0112) // Orientation
	order.PutUint16(tiff[12:], 3)      // SHORT
	order.PutUint32(tiff[14:], 1)      // count
	order.PutUint16(tiff[18:], uint16(orientation))

	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	seg = append(seg, payload...)

	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	return append(out, jpg[2:]...)
}

func TestJPEGOrientation(t *testing.T) {
	for _, order := range []binary.ByteOrder{binary.BigEndian, binary.LittleEndian} {
		for o := 1; o <= 8; o++ {
			data := jpegWithOrientation(t, 4, 2, o, order)
			got, err := JPEGOrientation(bytes.NewReader(data))
			if err != nil {
				t.Fatalf("orientation %d (%v): %v", o, order, err)
			}
			if got != o {
				t.Errorf("orientation %d (%v): got %d", o, order, got)
			}
		}
	}
}

func TestJPEGOrientationWithoutExif(t *testing.T) {
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
		t.Fatal(err)
	}
	got, err := JPEGOrientation(&buf)
	if err != nil || got != OrientationNormal {
		t.Errorf("got %d, %v", got, err)
	}
}

func TestJPEGOrientationRejectsNonJPEG(t *testing.T) {
	if _, err := JPEGOrientation(bytes.NewReader([]byte("\x89PNG\r\n\x1a\n"))); err == nil {
		t.Error("expected an error for a PNG stream")
	}
}

func TestJPEGOrientationTruncatedIsSafe(t *testing.T) {
	data := jpegWithOrientation(t, 4, 2, 6, binary.BigEndian)
	for cut := 0; cut < len(data); cut++ {
		// Errors are fine on truncated input; panics are not.
		_, _ = JPEGOrientation(bytes.NewReader(data[:cut]))
	}
}

func TestApplyOrientation(t *testing.T) {
	// A 3x2 image with a unique colour per pixel.
	src := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	px := func(x, y int) color.NRGBA { return color.NRGBA{R: uint8(x * 50), G: uint8(y * 50), B: 7, A: 255} }
	for y := 0; y < 2; y++ {
		for x := 0; x < 3; x++ {
			src.SetNRGBA(x, y, px(x, y))
		}
	}

	tests := []struct {
		orientation int
		w, h        int
		// where the source top-left pixel (0,0) ends up
		x0, y0 int
	}{
		{1, 3, 2, 0, 0},
		{2, 3, 2, 2, 0},
		{3, 3, 2, 2, 1},
		{4, 3, 2, 0, 1},
		{5, 2, 3, 0, 0},
		{6, 2, 3, 1, 0},
		{7, 2, 3, 1, 2},
		{8, 2, 3, 0, 2},
	}
	for _, tt := range tests {
		out := ApplyOrientation(src, tt.orientation)
		b := out.Bounds()
		if b.Dx() != tt.w || b.Dy() != tt.h {
			t.Errorf("orientation %d: size %dx%d, want %dx%d", tt.orientation, b.Dx(), b.Dy(), tt.w, tt.h)
			continue
		}
		if got := color.NRGBAModel.Convert(out.At(tt.x0, tt.y0)); got != px(0, 0) {
			t.Errorf("orientation %d: pixel at (%d,%d) = %v, want %v", tt.orientation, tt.x0, tt.y0, got, px(0, 0))
		}
	}
}

func encodeGIF(t *testing.T, w, h, frames int) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	g := &gif.GIF{}
	for i := 0; i < frames; i++ {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, w, h), pal))
		g.Delay = append(g.Delay, 5)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestScanGIF(t *testing.T) {
	info, err := ScanGIF(bytes.NewReader(encodeGIF(t, 30, 20, 7)))
	if err != nil {
		t.Fatalf("ScanGIF: %v", err)
	}
	if info.Width != 30 || info.Height != 20 || info.Frames != 7 {
		t.Errorf("got %+v", info)
	}
	if info.DecodedPixels() != 30*20*7 {
		t.Errorf("DecodedPixels = %d", info.DecodedPixels())
	}
}

func TestScanGIFRejectsGarbage(t *testing.T) {
	if _, err := ScanGIF(bytes.NewReader([]byte("not a gif at all"))); err == nil {
		t.Error("expected an error")
	}
	data := encodeGIF(t, 10, 10, 3)
	if _, err := ScanGIF(bytes.NewReader(data[:len(data)/2])); err == nil {
		t.Error("expected an error for a truncated GIF")
	}
}

func TestIsAnimatedWebP(t *testing.T) {
	vp8x := func(flags byte) []byte {
		b := []byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00")
		return append(b, flags, 0, 0, 0)
	}
	if !IsAnimatedWebP(bytes.NewReader(vp8x(0x02))) {
		t.Error("animation flag not detected")
	}
	if IsAnimatedWebP(bytes.NewReader(vp8x(0x10))) {
		t.Error("alpha-only VP8X reported as animated")
	}
	if IsAnimatedWebP(bytes.NewReader([]byte("RIFF\x00\x00\x00\x00WEBPVP8 \x00\x00\x00\x00\x00"))) {
		t.Error("simple VP8 reported as animated")
	}
}

func TestIsAnimatedPNG(t *testing.T) {
	chunk := func(typ string, data []byte) []byte {
		b := make([]byte, 4)
		binary.BigEndian.PutUint32(b, uint32(len(data)))
		b = append(b, typ...)
		b = append(b, data...)
		return append(b, 0, 0, 0, 0) // CRC is not verified
	}
	sig := []byte("\x89PNG\r\n\x1a\n")
	ihdr := chunk("IHDR", make([]byte, 13))

	apng := append(append(append([]byte{}, sig...), ihdr...), chunk("acTL", make([]byte, 8))...)
	apng = append(apng, chunk("IDAT", nil)...)
	if !IsAnimatedPNG(bytes.NewReader(apng)) {
		t.Error("APNG not detected")
	}

	png := append(append(append([]byte{}, sig...), ihdr...), chunk("IDAT", nil)...)
	if IsAnimatedPNG(bytes.NewReader(png)) {
		t.Error("plain PNG reported as animated")
	}
}
