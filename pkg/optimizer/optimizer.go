// Package optimizer produces smaller versions of images.
//
// The optimizer never modifies or removes the source image and never writes
// to a final file name: it returns a temp file next to the source (the
// "candidate") that is guaranteed to be strictly smaller than the original.
// Committing the candidate under a free name and retiring the original is
// the caller's decision, which keeps every destructive step explicit.
package optimizer

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"os"

	"obsidian-image-optimizer/pkg/config"
	"obsidian-image-optimizer/pkg/fsutil"
	"obsidian-image-optimizer/pkg/imageinfo"
	"obsidian-image-optimizer/pkg/imagekind"
)

// Options are the encoding settings derived from the configuration.
type Options struct {
	Quality       int
	GifMode       config.GifMode
	GifLossy      int
	MaxColors     int
	GifMaxWidth   int
	GifDropFrames bool
	MaxPixels     int64
}

// OptionsFromConfig extracts the encoding settings from cfg.
func OptionsFromConfig(cfg *config.Config) Options {
	return Options{
		Quality:       cfg.Quality,
		GifMode:       cfg.GifMode,
		GifLossy:      cfg.GifLossy,
		MaxColors:     cfg.MaxColors,
		GifMaxWidth:   cfg.GifMaxWidth,
		GifDropFrames: cfg.GifDropFrames,
		MaxPixels:     cfg.MaxPixels,
	}
}

// Result is the outcome of optimising one image.
type Result struct {
	// Candidate is a temp file with the optimised image, or "" when the
	// original should be kept. The caller must commit or remove it.
	Candidate string
	// Ext is the extension of the candidate (".webp" or ".gif").
	Ext string
	// Encoder is the name of the encoder that produced the candidate.
	Encoder string

	OriginalSize int64
	FinalSize    int64

	// KeptReason explains why the original is kept (Candidate == "").
	KeptReason string
	// EncodeErr aggregates encoder failures when no encoder succeeded.
	EncodeErr error
}

// Improved reports whether a smaller candidate was produced.
func (r *Result) Improved() bool { return r.Candidate != "" }

// SavingsPercent is the relative size reduction of the candidate.
func (r *Result) SavingsPercent() float64 {
	if r.OriginalSize == 0 {
		return 0
	}
	return float64(r.OriginalSize-r.FinalSize) / float64(r.OriginalSize) * 100
}

// Optimizer converts images using a fixed set of encoder chains.
type Optimizer struct {
	opts Options

	still    []Encoder // raster still images -> WebP
	gifWebP  []Encoder // GIF -> (animated) WebP
	gifToGIF []Encoder // GIF -> smaller GIF
}

// New builds an optimizer from the available tools. Encoders whose tool is
// missing are left out; the pure-Go GIF optimiser is always available.
func New(tools Toolchain, run CommandRunner, opts Options) *Optimizer {
	o := &Optimizer{opts: opts}

	if tools.Cwebp != "" {
		o.still = append(o.still, cwebpEncoder{bin: tools.Cwebp, run: run, quality: opts.Quality})
	}
	if tools.Ffmpeg != "" {
		o.still = append(o.still, ffmpegStillEncoder{bin: tools.Ffmpeg, run: run, quality: opts.Quality})
	}

	if tools.Gif2webp != "" {
		o.gifWebP = append(o.gifWebP, gif2webpEncoder{bin: tools.Gif2webp, run: run, quality: opts.Quality, maxWidth: opts.GifMaxWidth})
	}
	if tools.Ffmpeg != "" {
		o.gifWebP = append(o.gifWebP,
			ffmpegAnimEncoder{bin: tools.Ffmpeg, run: run, quality: opts.Quality, maxWidth: opts.GifMaxWidth},
			ffmpegStillEncoder{bin: tools.Ffmpeg, run: run, quality: opts.Quality})
	}

	if tools.Gifsicle != "" {
		o.gifToGIF = append(o.gifToGIF, gifsicleEncoder{bin: tools.Gifsicle, run: run,
			lossy: opts.GifLossy, maxColors: opts.MaxColors, maxWidth: opts.GifMaxWidth})
	}
	if tools.Ffmpeg != "" {
		o.gifToGIF = append(o.gifToGIF, ffmpegPaletteEncoder{bin: tools.Ffmpeg, run: run,
			maxColors: opts.MaxColors, maxWidth: opts.GifMaxWidth})
	}
	o.gifToGIF = append(o.gifToGIF, goGIFEncoder{maxColors: opts.MaxColors,
		dropFrames: opts.GifDropFrames, maxPixels: opts.MaxPixels})

	return o
}

// stage is one attempt: an encoder chain producing files with ext.
type stage struct {
	chain []Encoder
	ext   string
}

// Optimize produces a candidate for the image at srcPath (of the given kind)
// in workDir. It returns an error only for unexpected I/O failures or
// cancellation; images that cannot be improved yield a Result with a reason.
func (o *Optimizer) Optimize(ctx context.Context, srcPath string, kind imagekind.Kind, workDir string) (*Result, error) {
	info, err := os.Stat(srcPath)
	if err != nil {
		return nil, err
	}
	res := &Result{OriginalSize: info.Size(), FinalSize: info.Size()}

	src := Source{Path: srcPath, Kind: kind}
	var stages []stage

	switch kind {
	case imagekind.GIF:
		gi, err := scanGIF(srcPath)
		if err != nil {
			res.KeptReason = fmt.Sprintf("unreadable GIF: %v", err)
			return res, nil
		}
		src.Width, src.Height, src.Frames = gi.Width, gi.Height, gi.Frames
		stages = o.gifStages()

	case imagekind.JPEG, imagekind.PNG, imagekind.TIFF, imagekind.WebP, imagekind.BMP:
		if animated(srcPath, kind) {
			res.KeptReason = "animated image (would lose its animation)"
			return res, nil
		}
		upright, cleanup, err := o.uprightSource(src, workDir)
		if err != nil {
			res.KeptReason = fmt.Sprintf("cannot apply EXIF orientation: %v", err)
			return res, nil
		}
		defer cleanup()
		src = upright
		stages = []stage{{chain: o.still, ext: ".webp"}}

	case imagekind.SVG:
		res.KeptReason = "vector image"
		return res, nil

	default:
		res.KeptReason = "unsupported format"
		return res, nil
	}

	if len(stages) == 0 {
		res.KeptReason = "GIF mode keep"
		return res, nil
	}

	var encodeErrs []error
	for _, st := range stages {
		candidate, encoder, err := o.runChain(ctx, st.chain, src, workDir, st.ext)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if err != nil {
			encodeErrs = append(encodeErrs, err)
			continue
		}

		cinfo, err := os.Stat(candidate)
		if err != nil {
			os.Remove(candidate)
			return nil, err
		}
		if cinfo.Size() < res.OriginalSize {
			res.Candidate, res.Ext, res.Encoder, res.FinalSize = candidate, st.ext, encoder, cinfo.Size()
			return res, nil
		}
		os.Remove(candidate)
		res.KeptReason = fmt.Sprintf("%s result was not smaller", encoder)
	}

	if res.KeptReason == "" {
		res.EncodeErr = errors.Join(encodeErrs...)
		res.KeptReason = "no encoder succeeded"
	}
	return res, nil
}

// gifStages returns the attempts for a GIF according to the GIF mode.
func (o *Optimizer) gifStages() []stage {
	webp := stage{chain: o.gifWebP, ext: ".webp"}
	toGIF := stage{chain: o.gifToGIF, ext: ".gif"}
	switch o.opts.GifMode {
	case config.GifModeKeep:
		return nil
	case config.GifModeWebp:
		return []stage{webp}
	case config.GifModeOptimize:
		return []stage{toGIF}
	default: // auto
		return []stage{webp, toGIF}
	}
}

var errNoEncoder = errors.New("no encoder available (install cwebp, gif2webp, gifsicle or ffmpeg)")

// runChain tries the supporting encoders in order and returns the first
// non-empty output as a temp file in workDir.
func (o *Optimizer) runChain(ctx context.Context, chain []Encoder, src Source, workDir, ext string) (string, string, error) {
	tmp, err := fsutil.TempSibling(workDir, ext)
	if err != nil {
		return "", "", err
	}

	var errs []error
	for _, enc := range chain {
		if !enc.Supports(src) {
			continue
		}
		if err := enc.Encode(ctx, src, tmp); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", enc.Name(), err))
			if ctx.Err() != nil {
				break
			}
			continue
		}
		if info, err := os.Stat(tmp); err != nil || info.Size() == 0 {
			errs = append(errs, fmt.Errorf("%s: produced no output", enc.Name()))
			continue
		}
		return tmp, enc.Name(), nil
	}

	os.Remove(tmp)
	if len(errs) == 0 {
		return "", "", errNoEncoder
	}
	return "", "", errors.Join(errs...)
}

// uprightSource returns a source that displays upright. cwebp ignores the
// EXIF Orientation tag, so rotated JPEGs (typical for phone photos) are
// rotated in Go and handed over as a lossless PNG temp file.
func (o *Optimizer) uprightSource(src Source, workDir string) (Source, func(), error) {
	noop := func() {}
	if src.Kind != imagekind.JPEG {
		return src, noop, nil
	}

	f, err := os.Open(src.Path)
	if err != nil {
		return src, noop, err
	}
	defer f.Close()

	orientation, err := imageinfo.JPEGOrientation(f)
	if err != nil || orientation == imageinfo.OrientationNormal {
		return src, noop, nil
	}

	if _, err := f.Seek(0, 0); err != nil {
		return src, noop, err
	}
	cfg, err := jpeg.DecodeConfig(f)
	if err != nil {
		return src, noop, err
	}
	if int64(cfg.Width)*int64(cfg.Height) > o.opts.MaxPixels {
		return src, noop, fmt.Errorf("%w: %dx%d", errTooManyPixels, cfg.Width, cfg.Height)
	}
	if _, err := f.Seek(0, 0); err != nil {
		return src, noop, err
	}
	img, err := jpeg.Decode(f)
	if err != nil {
		return src, noop, err
	}

	tmp, err := fsutil.TempSibling(workDir, ".png")
	if err != nil {
		return src, noop, err
	}
	cleanup := func() { os.Remove(tmp) }
	if err := writePNG(tmp, imageinfo.ApplyOrientation(img, orientation)); err != nil {
		cleanup()
		return src, noop, err
	}
	return Source{Path: tmp, Kind: imagekind.PNG}, cleanup, nil
}

func writePNG(path string, img image.Image) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func scanGIF(path string) (imageinfo.GIFInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return imageinfo.GIFInfo{}, err
	}
	defer f.Close()
	return imageinfo.ScanGIF(f)
}

// animated reports whether a WebP or PNG file contains an animation.
func animated(path string, kind imagekind.Kind) bool {
	if kind != imagekind.WebP && kind != imagekind.PNG {
		return false
	}
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if kind == imagekind.WebP {
		return imageinfo.IsAnimatedWebP(f)
	}
	return imageinfo.IsAnimatedPNG(f)
}
