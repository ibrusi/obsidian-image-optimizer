// Package imageinfo reads image metadata without decoding pixel data: JPEG
// EXIF orientation and GIF frame counts. Both readers are bounded and safe to
// run on untrusted input.
package imageinfo

import (
	"bufio"
	"encoding/binary"
	"errors"
	"image"
	"image/draw"
	"io"
)

// OrientationNormal is the EXIF orientation of an image that needs no transform.
const OrientationNormal = 1

// maxSegments bounds how many JPEG marker segments are inspected.
const maxSegments = 64

var errNotJPEG = errors.New("not a JPEG stream")

// JPEGOrientation returns the EXIF Orientation tag (1-8) of a JPEG stream, or
// OrientationNormal when the tag is absent or malformed.
func JPEGOrientation(r io.Reader) (int, error) {
	br := bufio.NewReader(r)

	var soi [2]byte
	if _, err := io.ReadFull(br, soi[:]); err != nil {
		return 0, err
	}
	if soi[0] != 0xFF || soi[1] != 0xD8 {
		return 0, errNotJPEG
	}

	for i := 0; i < maxSegments; i++ {
		marker, err := nextMarker(br)
		if err != nil {
			return OrientationNormal, nil
		}
		// Standalone markers carry no length field.
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) {
			continue
		}
		// Start of scan or end of image: metadata segments are over.
		if marker == 0xDA || marker == 0xD9 {
			return OrientationNormal, nil
		}

		var lenBuf [2]byte
		if _, err := io.ReadFull(br, lenBuf[:]); err != nil {
			return OrientationNormal, nil
		}
		length := int(binary.BigEndian.Uint16(lenBuf[:])) - 2
		if length < 0 {
			return OrientationNormal, nil
		}

		if marker != 0xE1 {
			if _, err := br.Discard(length); err != nil {
				return OrientationNormal, nil
			}
			continue
		}

		payload := make([]byte, length)
		if _, err := io.ReadFull(br, payload); err != nil {
			return OrientationNormal, nil
		}
		if o, ok := exifOrientation(payload); ok {
			return o, nil
		}
	}
	return OrientationNormal, nil
}

func nextMarker(br *bufio.Reader) (byte, error) {
	b, err := br.ReadByte()
	if err != nil {
		return 0, err
	}
	if b != 0xFF {
		return 0, errNotJPEG
	}
	// Markers may be padded with any number of 0xFF fill bytes.
	for {
		b, err = br.ReadByte()
		if err != nil {
			return 0, err
		}
		if b != 0xFF {
			return b, nil
		}
	}
}

// exifOrientation parses an APP1 payload ("Exif\0\0" + TIFF structure) and
// returns the Orientation tag of IFD0.
func exifOrientation(payload []byte) (int, bool) {
	const exifHeader = "Exif\x00\x00"
	if len(payload) < len(exifHeader)+8 || string(payload[:len(exifHeader)]) != exifHeader {
		return 0, false
	}
	tiff := payload[len(exifHeader):]

	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, false
	}
	if order.Uint16(tiff[2:4]) != 42 {
		return 0, false
	}

	ifd := int(order.Uint32(tiff[4:8]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0, false
	}
	entries := int(order.Uint16(tiff[ifd : ifd+2]))
	for i := 0; i < entries; i++ {
		off := ifd + 2 + i*12
		if off+12 > len(tiff) {
			return 0, false
		}
		const tagOrientation, typeShort = 0x0112, 3
		if order.Uint16(tiff[off:off+2]) != tagOrientation {
			continue
		}
		if order.Uint16(tiff[off+2:off+4]) != typeShort {
			return 0, false
		}
		o := int(order.Uint16(tiff[off+8 : off+10]))
		if o < 1 || o > 8 {
			return 0, false
		}
		return o, true
	}
	return 0, false
}

// ApplyOrientation returns img transformed so that it displays upright for
// the given EXIF orientation (1-8).
func ApplyOrientation(img image.Image, orientation int) image.Image {
	if orientation <= OrientationNormal || orientation > 8 {
		return img
	}

	src := toNRGBA(img)
	w, h := src.Rect.Dx(), src.Rect.Dy()
	dw, dh := w, h
	if orientation >= 5 { // orientations 5-8 rotate by 90 degrees
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))

	for y := 0; y < h; y++ {
		row := src.Pix[y*src.Stride : y*src.Stride+w*4]
		for x := 0; x < w; x++ {
			dx, dy := orientedPoint(orientation, x, y, w, h)
			copy(dst.Pix[dy*dst.Stride+dx*4:dy*dst.Stride+dx*4+4], row[x*4:x*4+4])
		}
	}
	return dst
}

// orientedPoint maps source pixel (x, y) of a w*h image to its destination.
func orientedPoint(orientation, x, y, w, h int) (int, int) {
	switch orientation {
	case 2: // mirror horizontal
		return w - 1 - x, y
	case 3: // rotate 180
		return w - 1 - x, h - 1 - y
	case 4: // mirror vertical
		return x, h - 1 - y
	case 5: // transpose
		return y, x
	case 6: // rotate 90 CW
		return h - 1 - y, x
	case 7: // transverse
		return h - 1 - y, w - 1 - x
	case 8: // rotate 90 CCW
		return y, w - 1 - x
	}
	return x, y
}

func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok && n.Rect.Min == (image.Point{}) {
		return n
	}
	b := img.Bounds()
	dst := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Rect, img, b.Min, draw.Src)
	return dst
}
