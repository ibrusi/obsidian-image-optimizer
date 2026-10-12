import { dimensionsOf } from '../domain/dimensions.ts';
import { decodeGif, scanGif } from '../domain/gif.ts';
import { type Compression, compressionsFor, worthReplacing } from '../domain/policy.ts';
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

  // The image is decoded for every attempt: the encoder takes ownership of
  // the pixels, and decoding again costs less memory than keeping a copy.
  const best = await smallest(compressionsFor(type), async (compression) => {
    const pixels = await deps.decode(input);
    return deps.encodeStill(pixels, { compression, quality: settings.quality, method: settings.method }, signal);
  }, signal);
  if (!worthReplacing(input.byteLength, best.data.byteLength, settings.minSavingsPercent)) {
    return keep(`WebP saves less than ${settings.minSavingsPercent}% (${formatBytes(best.data.byteLength)})`);
  }
  return {
    data: best.data,
    ext: 'webp',
    replaced: true,
    detail: `${best.compression}, ${formatBytes(input.byteLength)} → ${formatBytes(best.data.byteLength)}`,
  };
}

interface Candidate {
  data: ArrayBuffer;
  compression: Compression;
}

// smallest encodes with each compression in turn and keeps the smallest
// result; on a tie the earlier compression wins.
async function smallest(
  compressions: readonly Compression[],
  encode: (compression: Compression) => Promise<{ data: ArrayBuffer }>,
  signal?: AbortSignal,
): Promise<Candidate> {
  let best: Candidate | null = null;
  for (const compression of compressions) {
    signal?.throwIfAborted();
    const { data } = await encode(compression);
    if (!best || data.byteLength < best.data.byteLength) best = { data, compression };
  }
  if (!best) throw new Error('no compression to try');
  return best;
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
  // Screen recordings are smallest lossless, clips of video lossy. The GIF
  // is decoded for every attempt, as the encoder takes the frames.
  const best = await smallest(compressionsFor('gif'), (compression) => {
    const gif = decodeGif(bytes);
    const frames = gif.frames.map((f) => ({ rgba: f.rgba.buffer, durationMs: f.durationMs }));
    return deps.encodeAnimation({ width: gif.width, height: gif.height, frames }, { compression, quality: settings.quality }, signal);
  }, signal);
  if (!worthReplacing(input.byteLength, best.data.byteLength, settings.minSavingsPercent)) {
    return keep(`animated WebP saves less than ${settings.minSavingsPercent}% (${formatBytes(best.data.byteLength)})`);
  }
  return {
    data: best.data,
    ext: 'webp',
    replaced: true,
    detail: `${info.frames} frames, ${best.compression}, ${formatBytes(input.byteLength)} → ${formatBytes(best.data.byteLength)}`,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function megapixels(pixels: number): string {
  return (pixels / 1e6).toFixed(1);
}
