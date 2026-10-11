package imageinfo

import (
	"bufio"
	"encoding/binary"
	"io"
)

// maxPNGChunks bounds how many PNG chunks are inspected before giving up.
const maxPNGChunks = 1024

// IsAnimatedWebP reports whether the WebP stream is animated (VP8X header
// with the animation flag). Still encoders would silently keep only the first
// frame of such files.
func IsAnimatedWebP(r io.Reader) bool {
	var head [21]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return false
	}
	const animationFlag = 0x02
	return string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP" &&
		string(head[12:16]) == "VP8X" && head[20]&animationFlag != 0
}

// IsAnimatedPNG reports whether the PNG stream is an APNG (an acTL chunk
// appears before the first IDAT chunk).
func IsAnimatedPNG(r io.Reader) bool {
	br := bufio.NewReader(r)
	if _, err := br.Discard(8); err != nil { // PNG signature
		return false
	}
	for i := 0; i < maxPNGChunks; i++ {
		var hdr [8]byte
		if _, err := io.ReadFull(br, hdr[:]); err != nil {
			return false
		}
		switch string(hdr[4:8]) {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		length := int(binary.BigEndian.Uint32(hdr[0:4]))
		if _, err := br.Discard(length + 4); err != nil { // data + CRC
			return false
		}
	}
	return false
}
