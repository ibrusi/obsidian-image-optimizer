// Choosing between lossless and lossy WebP before encoding.
//
// Which one is smaller depends on the content, not the file format: a PNG
// can be a screenshot or a photo, a GIF a screen recording or a video clip.
// Measured on screenshots, diagrams, renders and photos, the number of
// distinct colours separates them: up to about a thousand colours lossless
// won every time, from several thousand lossy did. Animations are told apart
// the same way, and by how much of the picture changes between frames: lossy
// noise differs from frame to frame, which defeats storing only the changed
// regions.
//
// Clear cases are encoded once, in the mode they call for, and fall back to
// the other mode only if the first gave no saving. Unclear cases try both.

export type Compression = 'lossless' | 'lossy';

export interface CompressionPlan {
  /** Compressions to try, in order. */
  readonly candidates: readonly Compression[];
  /** True: stop at the first result worth keeping. False: try all and keep the smallest. */
  readonly stopAtFirstWorthy: boolean;
}

/** At most this many colours: graphics, smallest lossless. */
export const LOSSLESS_MAX_COLORS = 1024;
/** At least this many colours: photographic, smallest lossy. */
export const LOSSY_MIN_COLORS = 8192;
/** Animations with at most this many colours in a frame: flat graphics. */
export const ANIMATION_LOSSLESS_MAX_COLORS = 64;
/** At most this share of pixels changing between frames: a screen recording. */
export const ANIMATION_LOSSLESS_MAX_CHANGE = 0.05;
/** At least this share of pixels changing between frames: video. */
export const ANIMATION_LOSSY_MIN_CHANGE = 0.5;

const LOSSLESS_FIRST: CompressionPlan = { candidates: ['lossless', 'lossy'], stopAtFirstWorthy: true };
const LOSSY_FIRST: CompressionPlan = { candidates: ['lossy', 'lossless'], stopAtFirstWorthy: true };
const BOTH: CompressionPlan = { candidates: ['lossless', 'lossy'], stopAtFirstWorthy: false };
/** JPEG holds photos, which never shrink lossless. */
export const LOSSY_ONLY: CompressionPlan = { candidates: ['lossy'], stopAtFirstWorthy: true };

export function planForStill(colors: number): CompressionPlan {
  if (colors <= LOSSLESS_MAX_COLORS) return LOSSLESS_FIRST;
  if (colors >= LOSSY_MIN_COLORS) return LOSSY_FIRST;
  return BOTH;
}

export function planForAnimation(colors: number, changedShare: number): CompressionPlan {
  if (colors <= ANIMATION_LOSSLESS_MAX_COLORS || changedShare <= ANIMATION_LOSSLESS_MAX_CHANGE) return LOSSLESS_FIRST;
  if (changedShare >= ANIMATION_LOSSY_MIN_CHANGE) return LOSSY_FIRST;
  return BOTH;
}

type Pixels = Uint8Array | Uint8ClampedArray;

// countColors counts distinct RGBA values, stopping once the count exceeds
// cap: photos reach any useful cap within a few rows.
export function countColors(rgba: Pixels, cap: number): number {
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.byteLength >>> 2);
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i++) {
    seen.add(pixels[i]);
    if (seen.size > cap) break;
  }
  return seen.size;
}

// changedShare returns the average share of pixels, 0–1, that differ from
// the previous frame. Frames are full-canvas RGBA of equal size.
export function changedShare(frames: readonly Pixels[]): number {
  if (frames.length < 2) return 0;
  let changed = 0;
  let total = 0;
  for (let f = 1; f < frames.length; f++) {
    const current = new Uint32Array(frames[f].buffer, frames[f].byteOffset, frames[f].byteLength >>> 2);
    const previous = new Uint32Array(frames[f - 1].buffer, frames[f - 1].byteOffset, frames[f - 1].byteLength >>> 2);
    for (let i = 0; i < current.length; i++) if (current[i] !== previous[i]) changed++;
    total += current.length;
  }
  return total === 0 ? 0 : changed / total;
}
