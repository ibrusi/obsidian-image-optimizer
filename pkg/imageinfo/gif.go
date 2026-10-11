package imageinfo

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// GIFInfo describes a GIF without decoding its pixels.
type GIFInfo struct {
	Width, Height int
	Frames        int
}

// DecodedPixels is the number of pixels a full in-memory decode allocates
// (every frame is at most the size of the logical screen).
func (g GIFInfo) DecodedPixels() int64 {
	return int64(g.Width) * int64(g.Height) * int64(g.Frames)
}

var errNotGIF = errors.New("not a GIF stream")

// ScanGIF walks the GIF block structure and counts image frames, skipping the
// LZW data instead of decompressing it, so it is cheap even for GIF bombs.
func ScanGIF(r io.Reader) (GIFInfo, error) {
	br := bufio.NewReader(r)

	var header [13]byte // signature (6) + logical screen descriptor (7)
	if _, err := io.ReadFull(br, header[:]); err != nil {
		return GIFInfo{}, err
	}
	if sig := string(header[:6]); sig != "GIF87a" && sig != "GIF89a" {
		return GIFInfo{}, errNotGIF
	}

	info := GIFInfo{
		Width:  int(binary.LittleEndian.Uint16(header[6:8])),
		Height: int(binary.LittleEndian.Uint16(header[8:10])),
	}
	if flags := header[10]; flags&0x80 != 0 {
		if err := skip(br, colorTableSize(flags)); err != nil {
			return info, err
		}
	}

	for {
		introducer, err := br.ReadByte()
		if err != nil {
			return info, err
		}
		switch introducer {
		case 0x21: // extension: label byte, then data sub-blocks
			if _, err := br.ReadByte(); err != nil {
				return info, err
			}
			if err := skipSubBlocks(br); err != nil {
				return info, err
			}
		case 0x2C: // image descriptor
			var desc [9]byte
			if _, err := io.ReadFull(br, desc[:]); err != nil {
				return info, err
			}
			if flags := desc[8]; flags&0x80 != 0 {
				if err := skip(br, colorTableSize(flags)); err != nil {
					return info, err
				}
			}
			if _, err := br.ReadByte(); err != nil { // LZW minimum code size
				return info, err
			}
			if err := skipSubBlocks(br); err != nil {
				return info, err
			}
			info.Frames++
		case 0x3B: // trailer
			return info, nil
		default:
			return info, fmt.Errorf("gif: unknown block introducer 0x%02x", introducer)
		}
	}
}

func colorTableSize(flags byte) int {
	return 3 * (1 << (int(flags&0x07) + 1))
}

func skipSubBlocks(br *bufio.Reader) error {
	for {
		size, err := br.ReadByte()
		if err != nil {
			return err
		}
		if size == 0 {
			return nil
		}
		if err := skip(br, int(size)); err != nil {
			return err
		}
	}
}

func skip(br *bufio.Reader, n int) error {
	_, err := br.Discard(n)
	return err
}
