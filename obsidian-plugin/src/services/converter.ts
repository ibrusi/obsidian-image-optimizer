import { dimensionsOf } from '../domain/dimensions.ts';
import { worthReplacing } from '../domain/policy.ts';
import { extensionOf, type ImageType } from '../domain/sniff.ts';
import type { StillOptions } from '../codec/protocol.ts';
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
  if (type === 'gif') return keep('GIF kept as is');

  const size = dimensionsOf(new Uint8Array(input), type);
  if (size && size.width * size.height > settings.maxMegapixels * 1e6) {
    return keep(`too large to convert: ${megapixels(size.width * size.height)} MP`);
  }

  signal?.throwIfAborted();
  const pixels = await deps.decode(input);
  const encoded = await deps.encodeStill(pixels, { quality: settings.quality, method: settings.method }, signal);
  if (!worthReplacing(input.byteLength, encoded.data.byteLength, settings.minSavingsPercent)) {
    return keep(`WebP saves less than ${settings.minSavingsPercent}% (${formatBytes(encoded.data.byteLength)})`);
  }
  return {
    data: encoded.data,
    ext: 'webp',
    replaced: true,
    detail: `${formatBytes(input.byteLength)} → ${formatBytes(encoded.data.byteLength)}`,
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
