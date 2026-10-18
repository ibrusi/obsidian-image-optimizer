import { dimensionsOf } from '../domain/dimensions.ts';
import { type DecodedGif, decodeGif, scanGif } from '../domain/gif.ts';
import {
  ANIMATION_LOSSLESS_MAX_COLORS, changedShare, type Compression, type CompressionPlan, countColors,
  LOSSY_MIN_COLORS, LOSSY_ONLY, planForAnimation, planForStill,
} from '../domain/compression.ts';
import { worthReplacing } from '../domain/policy.ts';
import { extensionOf, type ImageType } from '../domain/sniff.ts';
import type { AnimationFrame, AnimationOptions, StillOptions } from '../codec/protocol.ts';
import type { PluginSettings } from '../settings.ts';

export interface Converted {
  data: ArrayBuffer;
  ext: string;
  /** False when the original bytes are returned unchanged. */
  replaced: boolean;
  detail: string;
}

export interface ConvertDeps {
  decode(source: ArrayBuffer): Promise<ImageData>;
  encodeStill(pixels: ImageData, options: StillOptions, signal?: AbortSignal): Promise<{ data: ArrayBuffer }>;
  encodeAnimation(
    animation: { width: number; height: number; frames: AnimationFrame[] },
    options: AnimationOptions,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer }>;
}

export type ConvertSettings = Pick<PluginSettings, 'quality' | 'method' | 'minSavingsPercent' | 'gifMode' | 'maxMegapixels'>;

// convert returns WebP bytes when they are worth it, and the original bytes
// otherwise. "Not worth it" is a normal outcome, not an error: callers only
// handle real failures. WebP input is never re-encoded, so repeated runs do
// not degrade images.
export async function convert(
  input: ArrayBuffer,
  type: ImageType,
  settings: ConvertSettings,
  deps: ConvertDeps,
  signal?: AbortSignal,
): Promise<Converted> {
  const keep = (detail: string): Converted => ({ data: input, ext: extensionOf(type), replaced: false, detail });

  if (type === 'webp') return keep('already WebP');
  // A vector image stays sharp at any size and is usually smaller than any
  // raster of it: it is saved as it is.
  if (type === 'svg') return keep('SVG kept as is');
  if (type === 'pdf') return keep('PDF kept as is');
  if (type === 'gif') {
    if (settings.gifMode === 'keep') return keep('GIF kept as is (settings)');
    const animated = await convertAnimatedGif(input, settings, deps, signal);
    if (animated) return animated;
    // A single-frame GIF is a still image: the platform decoder handles it.
  }

  const size = dimensionsOf(new Uint8Array(input), type);
  if (size && size.width * size.height > settings.maxMegapixels * 1e6) {
    return keep(`too large to convert: ${megapixels(size.width * size.height)} MP`);
  }

  // The pixels decoded for choosing the plan feed the first attempt; a
  // fallback decodes again, as the encoder takes ownership of the pixels and
  // decoding costs less memory than keeping a copy.
  let decoded: ImageData | null = await deps.decode(input);
  const plan = type === 'jpeg' ? LOSSY_ONLY : planForStill(countColors(decoded.data, LOSSY_MIN_COLORS));
  const best = await encodeByPlan(plan, async (compression) => {
    const pixels = decoded ?? await deps.decode(input);
    decoded = null;
    return deps.encodeStill(pixels, { compression, quality: settings.quality, method: settings.method }, signal);
  }, (size) => worthReplacing(input.byteLength, size, settings.minSavingsPercent), signal);
  if (!worthReplacing(input.byteLength, best.data.byteLength, settings.minSavingsPercent)) {
    return keep(`WebP saves less than ${settings.minSavingsPercent}% (${formatBytes(best.data.byteLength)})`);
  }
  return {
    data: best.data,
    ext: 'webp',
    replaced: true,
    detail: `${best.compression}, ${formatChange(input.byteLength, best.data.byteLength)}`,
  };
}

interface Candidate {
  data: ArrayBuffer;
  compression: Compression;
}

// encodeByPlan encodes with the plan's compressions in turn and returns the
// smallest result (on a tie the earlier one). A plan sure of its first
// choice stops as soon as a result is worth keeping.
async function encodeByPlan(
  plan: CompressionPlan,
  encode: (compression: Compression) => Promise<{ data: ArrayBuffer }>,
  worthy: (size: number) => boolean,
  signal?: AbortSignal,
): Promise<Candidate> {
  let best: Candidate | null = null;
  for (const compression of plan.candidates) {
    signal?.throwIfAborted();
    const { data } = await encode(compression);
    if (!best || data.byteLength < best.data.byteLength) best = { data, compression };
    if (plan.stopAtFirstWorthy && worthy(best.data.byteLength)) break;
  }
  if (!best) throw new Error('no compression to try');
  return best;
}

// animationPlan measures the frames without keeping references to them, so
// they can be freed once the encoder has them.
function animationPlan(gif: DecodedGif): CompressionPlan {
  const frames = gif.frames.map((f) => f.rgba);
  return planForAnimation(countColors(frames[0], ANIMATION_LOSSLESS_MAX_COLORS), changedShare(frames));
}

// convertAnimatedGif returns null for single-frame GIFs.
async function convertAnimatedGif(
  input: ArrayBuffer,
  settings: ConvertSettings,
  deps: ConvertDeps,
  signal?: AbortSignal,
): Promise<Converted | null> {
  const keep = (detail: string): Converted => ({ data: input, ext: 'gif', replaced: false, detail });
  const bytes = new Uint8Array(input);
  const info = scanGif(bytes);
  if (!info) return keep('unreadable GIF');
  if (info.frames <= 1) return null;

  const pixels = info.width * info.height * info.frames;
  // All decoded frames are in memory at once: their total counts.
  if (pixels > settings.maxMegapixels * 1e6) {
    return keep(`animation too large to convert: ${info.frames} frames, ${megapixels(pixels)} MP in total`);
  }
  // Like still images, the frames decoded for the plan feed the first
  // attempt and a fallback decodes the GIF again.
  let decoded: DecodedGif | null = decodeGif(bytes);
  const plan = animationPlan(decoded);
  const best = await encodeByPlan(plan, (compression) => {
    const gif = decoded ?? decodeGif(bytes);
    decoded = null;
    const frames = gif.frames.map((f) => ({ rgba: f.rgba.buffer, durationMs: f.durationMs }));
    return deps.encodeAnimation({ width: gif.width, height: gif.height, frames }, { compression, quality: settings.quality }, signal);
  }, (size) => worthReplacing(input.byteLength, size, settings.minSavingsPercent), signal);
  if (!worthReplacing(input.byteLength, best.data.byteLength, settings.minSavingsPercent)) {
    return keep(`animated WebP saves less than ${settings.minSavingsPercent}% (${formatBytes(best.data.byteLength)})`);
  }
  return {
    data: best.data,
    ext: 'webp',
    replaced: true,
    detail: `${info.frames} frames, ${best.compression}, ${formatChange(input.byteLength, best.data.byteLength)}`,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function savingsPercent(before: number, after: number): number {
  return before > 0 && after < before ? Math.round(((before - after) / before) * 100) : 0;
}

function formatChange(before: number, after: number): string {
  return `${formatBytes(before)} → ${formatBytes(after)} (-${savingsPercent(before, after)}%)`;
}

function megapixels(pixels: number): string {
  return (pixels / 1e6).toFixed(1);
}
