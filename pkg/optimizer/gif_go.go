package optimizer

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"math"
	"os"
	"slices"
	"sort"

	"obsidian-image-optimizer/pkg/imagekind"
)

// dropFramesMin is the minimum frame count for which --gif-drop-frames applies.
const dropFramesMin = 10

// errTooManyPixels is returned when decoding an image would exceed --max-pixels.
var errTooManyPixels = errors.New("image exceeds max-pixels limit")

// goGIFEncoder recompresses GIFs in pure Go when no external tool is
// available: it reduces palettes to the most used colours (keeping
// transparency exact) and can drop every second frame.
type goGIFEncoder struct {
	maxColors  int
	dropFrames bool
	maxPixels  int64
}

func (e goGIFEncoder) Name() string { return "go-gif" }

func (e goGIFEncoder) Supports(src Source) bool { return src.Kind == imagekind.GIF }

func (e goGIFEncoder) Encode(ctx context.Context, src Source, dst string) error {
	if pixels := int64(src.Width) * int64(src.Height) * int64(src.Frames); pixels > e.maxPixels {
		return fmt.Errorf("%w: %d frames of %dx%d", errTooManyPixels, src.Frames, src.Width, src.Height)
	}

	in, err := os.Open(src.Path)
	if err != nil {
		return err
	}
	g, err := gif.DecodeAll(in)
	in.Close()
	if err != nil {
		return fmt.Errorf("decode GIF: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	var out *gif.GIF
	if e.dropFrames && len(g.Image) > dropFramesMin {
		out = dropAlternateFrames(g, e.maxColors)
	} else {
		out = reducePalettes(g, e.maxColors)
	}

	f, err := os.OpenFile(dst, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	if err := gif.EncodeAll(f, out); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// reducePalettes keeps every frame (with its rectangle and disposal) and
// shrinks each distinct palette to the maxColors most used entries.
func reducePalettes(g *gif.GIF, maxColors int) *gif.GIF {
	// Pass 1: usage histogram per distinct palette.
	type paletteUsage struct {
		palette color.Palette
		counts  [256]int
	}
	usage := make(map[string]*paletteUsage)
	for _, frame := range g.Image {
		key := paletteKey(frame.Palette)
		u, ok := usage[key]
		if !ok {
			u = &paletteUsage{palette: frame.Palette}
			usage[key] = u
		}
		for _, idx := range frame.Pix {
			u.counts[idx]++
		}
	}

	// Pass 2: one reduction per distinct palette, so frames that shared a
	// palette still share the reduced one (and the global colour table).
	type reduction struct {
		palette color.Palette
		mapping []uint8 // nil when the palette is already small enough
	}
	reductions := make(map[string]reduction, len(usage))
	for key, u := range usage {
		p, m := reducePalette(u.palette, u.counts[:], maxColors)
		reductions[key] = reduction{palette: p, mapping: m}
	}

	// Pass 3: remap pixel indices.
	out := &gif.GIF{
		Image:     make([]*image.Paletted, len(g.Image)),
		Delay:     append([]int(nil), g.Delay...),
		Disposal:  append([]byte(nil), g.Disposal...),
		LoopCount: g.LoopCount,
		Config:    image.Config{Width: g.Config.Width, Height: g.Config.Height},
	}
	for i, frame := range g.Image {
		r := reductions[paletteKey(frame.Palette)]
		out.Image[i] = remapFrame(frame, r.palette, r.mapping)
	}

	if global, ok := g.Config.ColorModel.(color.Palette); ok {
		if r, ok := reductions[paletteKey(global)]; ok {
			out.Config.ColorModel = r.palette
			out.BackgroundIndex = g.BackgroundIndex
			if r.mapping != nil && int(g.BackgroundIndex) < len(r.mapping) {
				out.BackgroundIndex = r.mapping[g.BackgroundIndex]
			}
		}
	}
	return out
}

// dropAlternateFrames composites the animation (honouring disposal methods
// and frame rectangles) and keeps every second full frame, merging delays.
// Dropping frames of a delta-encoded GIF without compositing would corrupt it.
func dropAlternateFrames(g *gif.GIF, maxColors int) *gif.GIF {
	screen := image.Rect(0, 0, g.Config.Width, g.Config.Height)
	if screen.Empty() {
		screen = g.Image[0].Bounds()
	}
	canvas := image.NewRGBA(screen)

	out := &gif.GIF{
		LoopCount: g.LoopCount,
		Config:    image.Config{Width: screen.Dx(), Height: screen.Dy()},
	}

	for i, frame := range g.Image {
		disposal := byte(gif.DisposalNone)
		if i < len(g.Disposal) {
			disposal = g.Disposal[i]
		}
		var saved *image.RGBA
		if disposal == gif.DisposalPrevious {
			saved = image.NewRGBA(screen)
			copy(saved.Pix, canvas.Pix)
		}

		draw.Draw(canvas, frame.Bounds(), frame, frame.Bounds().Min, draw.Over)

		delay := 0
		if i < len(g.Delay) {
			delay = g.Delay[i]
		}
		if i%2 == 0 {
			out.Image = append(out.Image, quantizeRGBA(canvas, maxColors))
			out.Delay = append(out.Delay, delay)
			// Every output frame covers the whole screen, so restoring to
			// background between frames reproduces the composited result.
			out.Disposal = append(out.Disposal, gif.DisposalBackground)
		} else {
			out.Delay[len(out.Delay)-1] += delay
		}

		switch disposal {
		case gif.DisposalBackground:
			draw.Draw(canvas, frame.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			copy(canvas.Pix, saved.Pix)
		}
	}
	return out
}

// reducePalette returns the maxColors most used entries of pal and a mapping
// from old to new indices. Transparent entries are kept exactly and opaque
// colours are never mapped to transparency.
func reducePalette(pal color.Palette, counts []int, maxColors int) (color.Palette, []uint8) {
	if len(pal) <= maxColors {
		return pal, nil
	}

	// A used transparent entry must survive the cut regardless of its count.
	score := func(i int) int {
		if counts[i] > 0 && isTransparent(pal[i]) {
			return math.MaxInt
		}
		return counts[i]
	}
	order := make([]int, len(pal))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return score(order[a]) > score(order[b]) })

	reduced := make(color.Palette, 0, maxColors)
	for _, idx := range order {
		if len(reduced) == maxColors || (score(idx) == 0 && len(reduced) > 0) {
			break
		}
		reduced = append(reduced, pal[idx])
	}

	mapping := make([]uint8, len(pal))
	for i, c := range pal {
		mapping[i] = uint8(nearestIndex(reduced, c))
	}
	return reduced, mapping
}

func remapFrame(src *image.Paletted, pal color.Palette, mapping []uint8) *image.Paletted {
	if mapping == nil {
		return src
	}
	dst := image.NewPaletted(src.Rect, pal)
	for i, idx := range src.Pix {
		dst.Pix[i] = mapping[idx]
	}
	return dst
}

// quantizeRGBA converts a composited frame to a palette of the most used colours.
func quantizeRGBA(img *image.RGBA, maxColors int) *image.Paletted {
	counts := make(map[uint32]int)
	for i := 0; i < len(img.Pix); i += 4 {
		counts[packRGBA(img.Pix[i:i+4])]++
	}

	colors := make([]uint32, 0, len(counts))
	for c := range counts {
		colors = append(colors, c)
	}
	sort.Slice(colors, func(a, b int) bool {
		if counts[colors[a]] != counts[colors[b]] {
			return counts[colors[a]] > counts[colors[b]]
		}
		return colors[a] < colors[b] // deterministic output
	})
	if len(colors) > maxColors {
		colors = colors[:maxColors]
	}
	// A transparent pixel must stay transparent even if transparency is rare.
	if _, ok := counts[0]; ok && !slices.Contains(colors, 0) {
		colors[len(colors)-1] = 0
	}

	pal := make(color.Palette, len(colors))
	for i, c := range colors {
		pal[i] = unpackRGBA(c)
	}

	dst := image.NewPaletted(img.Rect, pal)
	cache := make(map[uint32]uint8, len(counts))
	for i, j := 0, 0; i < len(img.Pix); i, j = i+4, j+1 {
		c := packRGBA(img.Pix[i : i+4])
		idx, ok := cache[c]
		if !ok {
			idx = uint8(nearestIndex(pal, unpackRGBA(c)))
			cache[c] = idx
		}
		dst.Pix[j] = idx
	}
	return dst
}

// nearestIndex finds the closest palette entry, matching transparent colours
// only with transparent entries and opaque colours only with opaque ones.
func nearestIndex(pal color.Palette, c color.Color) int {
	wantTransparent := isTransparent(c)
	r, g, b, _ := c.RGBA()
	best, bestDist := 0, uint64(1<<63)
	for i, p := range pal {
		if isTransparent(p) != wantTransparent {
			continue
		}
		if wantTransparent {
			return i
		}
		pr, pg, pb, _ := p.RGBA()
		d := sqDiff(r, pr) + sqDiff(g, pg) + sqDiff(b, pb)
		if d < bestDist {
			best, bestDist = i, d
		}
	}
	return best
}

func isTransparent(c color.Color) bool {
	_, _, _, a := c.RGBA()
	return a == 0
}

func sqDiff(a, b uint32) uint64 {
	d := int64(a) - int64(b)
	return uint64(d * d)
}

// packRGBA packs a premultiplied RGBA pixel; fully transparent pixels collapse to 0.
func packRGBA(p []uint8) uint32 {
	if p[3] == 0 {
		return 0
	}
	return uint32(p[0])<<24 | uint32(p[1])<<16 | uint32(p[2])<<8 | uint32(p[3])
}

func unpackRGBA(c uint32) color.RGBA {
	return color.RGBA{R: uint8(c >> 24), G: uint8(c >> 16), B: uint8(c >> 8), A: uint8(c)}
}

func paletteKey(p color.Palette) string {
	b := make([]byte, 0, len(p)*4)
	for _, c := range p {
		r, g, bl, a := c.RGBA()
		b = append(b, byte(r>>8), byte(g>>8), byte(bl>>8), byte(a>>8))
	}
	return string(b)
}
