package optimizer

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"obsidian-image-optimizer/pkg/imagekind"
)

// Source describes the image handed to an encoder.
type Source struct {
	Path string
	Kind imagekind.Kind

	// Width, Height and Frames are known for GIFs (from imageinfo.ScanGIF).
	Width, Height, Frames int
}

// Encoder converts a source image into dst, overwriting dst.
type Encoder interface {
	Name() string
	Supports(src Source) bool
	Encode(ctx context.Context, src Source, dst string) error
}

// errCannotResize is returned by encoders that cannot honour --gif-max-width.
var errCannotResize = errors.New("encoder cannot resize; skipped because gif-max-width applies")

// cwebpEncoder encodes still images with libwebp's cwebp. It keeps the ICC
// profile (colour accuracy) and drops EXIF/XMP; orientation is applied
// beforehand because cwebp ignores the EXIF Orientation tag.
type cwebpEncoder struct {
	bin     string
	run     CommandRunner
	quality int
}

func (e cwebpEncoder) Name() string { return "cwebp" }

func (e cwebpEncoder) Supports(src Source) bool {
	switch src.Kind {
	case imagekind.JPEG, imagekind.PNG, imagekind.TIFF, imagekind.WebP:
		return true
	}
	return false
}

func (e cwebpEncoder) Encode(ctx context.Context, src Source, dst string) error {
	return e.run.Run(ctx, e.bin, "-quiet", "-q", strconv.Itoa(e.quality), "-m", "6",
		"-metadata", "icc", src.Path, "-o", dst)
}

// ffmpegStillEncoder encodes a single frame with ffmpeg's libwebp.
type ffmpegStillEncoder struct {
	bin     string
	run     CommandRunner
	quality int
}

func (e ffmpegStillEncoder) Name() string { return "ffmpeg" }

func (e ffmpegStillEncoder) Supports(src Source) bool {
	switch src.Kind {
	case imagekind.JPEG, imagekind.PNG, imagekind.TIFF, imagekind.WebP, imagekind.BMP:
		return true
	case imagekind.GIF:
		return src.Frames <= 1
	}
	return false
}

func (e ffmpegStillEncoder) Encode(ctx context.Context, src Source, dst string) error {
	return e.run.Run(ctx, e.bin, ffmpegArgs(src.Path, dst,
		"-frames:v", "1", "-c:v", "libwebp",
		"-quality", strconv.Itoa(e.quality), "-compression_level", "6")...)
}

// gif2webpEncoder converts (animated) GIFs to lossy WebP with libwebp's gif2webp.
type gif2webpEncoder struct {
	bin      string
	run      CommandRunner
	quality  int
	maxWidth int
}

func (e gif2webpEncoder) Name() string { return "gif2webp" }

func (e gif2webpEncoder) Supports(src Source) bool { return src.Kind == imagekind.GIF }

func (e gif2webpEncoder) Encode(ctx context.Context, src Source, dst string) error {
	if needsResize(src, e.maxWidth) {
		return errCannotResize
	}
	return e.run.Run(ctx, e.bin, "-quiet", "-lossy", "-q", strconv.Itoa(e.quality), "-m", "6",
		src.Path, "-o", dst)
}

// ffmpegAnimEncoder converts animated GIFs to animated WebP with ffmpeg.
type ffmpegAnimEncoder struct {
	bin      string
	run      CommandRunner
	quality  int
	maxWidth int
}

func (e ffmpegAnimEncoder) Name() string { return "ffmpeg" }

func (e ffmpegAnimEncoder) Supports(src Source) bool {
	return src.Kind == imagekind.GIF && src.Frames > 1
}

func (e ffmpegAnimEncoder) Encode(ctx context.Context, src Source, dst string) error {
	var args []string
	if needsResize(src, e.maxWidth) {
		args = append(args, "-vf", scaleFilter(e.maxWidth))
	}
	args = append(args, "-c:v", "libwebp_anim", "-quality", strconv.Itoa(e.quality),
		"-compression_level", "6", "-loop", "0")
	return e.run.Run(ctx, e.bin, ffmpegArgs(src.Path, dst, args...)...)
}

// gifsicleEncoder recompresses GIFs with gifsicle's lossy LZW optimisation.
type gifsicleEncoder struct {
	bin       string
	run       CommandRunner
	lossy     int
	maxColors int
	maxWidth  int
}

func (e gifsicleEncoder) Name() string { return "gifsicle" }

func (e gifsicleEncoder) Supports(src Source) bool { return src.Kind == imagekind.GIF }

func (e gifsicleEncoder) Encode(ctx context.Context, src Source, dst string) error {
	args := []string{"--no-warnings", "-O3", "--lossy=" + strconv.Itoa(e.lossy)}
	if e.maxColors < 256 {
		args = append(args, "--colors", strconv.Itoa(e.maxColors))
	}
	if needsResize(src, e.maxWidth) {
		args = append(args, "--resize-fit-width", strconv.Itoa(e.maxWidth))
	}
	args = append(args, src.Path, "-o", dst)
	return e.run.Run(ctx, e.bin, args...)
}

// ffmpegPaletteEncoder re-renders GIFs with an optimal ffmpeg palette.
type ffmpegPaletteEncoder struct {
	bin       string
	run       CommandRunner
	maxColors int
	maxWidth  int
}

func (e ffmpegPaletteEncoder) Name() string { return "ffmpeg-palette" }

func (e ffmpegPaletteEncoder) Supports(src Source) bool { return src.Kind == imagekind.GIF }

func (e ffmpegPaletteEncoder) Encode(ctx context.Context, src Source, dst string) error {
	filter := fmt.Sprintf("split[s0][s1];[s0]palettegen=max_colors=%d[p];[s1][p]paletteuse", e.maxColors)
	if needsResize(src, e.maxWidth) {
		filter = scaleFilter(e.maxWidth) + "," + filter
	}
	return e.run.Run(ctx, e.bin, ffmpegArgs(src.Path, dst, "-vf", filter)...)
}

// ffmpegArgs builds a non-interactive ffmpeg command line. The "file:"
// prefix stops ffmpeg from interpreting a path containing ':' as a protocol.
func ffmpegArgs(src, dst string, extra ...string) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", "file:" + src}
	args = append(args, extra...)
	return append(args, "file:"+dst)
}

func scaleFilter(maxWidth int) string {
	return fmt.Sprintf("scale=%d:-2:flags=lanczos", maxWidth)
}

func needsResize(src Source, maxWidth int) bool {
	return maxWidth > 0 && src.Width > maxWidth
}
