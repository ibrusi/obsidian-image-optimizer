import { simd } from 'wasm-feature-detect';
import type { EncodeOptions, WebPModule } from '@jsquash/webp/codec/enc/webp_enc.js';
import { defaultOptions } from '@jsquash/webp/meta.js';
import { initEmscriptenModule } from '@jsquash/webp/utils.js';
import scalarFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import simdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import scalarWasm from '@jsquash/webp/codec/enc/webp_enc.wasm';
import simdWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';

// Settings of the desktop CLI (cwebp -q 40 -m 6): the same libwebp build
// with the same options gives the same visual result.
export const DEFAULT_QUALITY = 40;
export const DEFAULT_METHOD = 6;

export type EncoderVariant = 'simd' | 'scalar';

interface LoadedEncoder {
  module: WebPModule;
  variant: EncoderVariant;
  initMs: number;
}

const encoders = new Map<EncoderVariant, Promise<LoadedEncoder>>();

// detectVariant picks the SIMD build when the WebAssembly engine supports it.
export async function detectVariant(): Promise<EncoderVariant> {
  return (await simd()) ? 'simd' : 'scalar';
}

// loadEncoder compiles an encoder once, lazily, so plugin startup stays fast.
export function loadEncoder(variant: EncoderVariant): Promise<LoadedEncoder> {
  let loaded = encoders.get(variant);
  if (!loaded) {
    loaded = instantiate(variant);
    encoders.set(variant, loaded);
    loaded.catch(() => encoders.delete(variant)); // allow a retry after failure
  }
  return loaded;
}

async function instantiate(variant: EncoderVariant): Promise<LoadedEncoder> {
  const started = performance.now();
  const bytes = variant === 'simd' ? simdWasm : scalarWasm;
  const factory = variant === 'simd' ? simdFactory : scalarFactory;
  const compiled = await WebAssembly.compile(bytes);
  // locateFile stops the glue from deriving the .wasm URL from
  // import.meta.url, which does not exist in the plugin bundle.
  const module = await initEmscriptenModule(factory, compiled, { locateFile: (path: string) => path });
  return { module, variant, initMs: performance.now() - started };
}

export interface Decoded {
  pixels: ImageData;
  ms: number;
}

// decode uses the platform image decoder, which also applies EXIF
// orientation, and returns RGBA pixels.
export async function decode(source: ArrayBuffer): Promise<Decoded> {
  const started = performance.now();
  const bitmap = await createImageBitmap(new Blob([source]));
  try {
    const canvas = document.createElement('canvas'); // OffscreenCanvas is missing on older iOS
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas is not available');
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { pixels, ms: performance.now() - started };
  } finally {
    bitmap.close();
  }
}

export interface Encoded {
  data: Uint8Array;
  ms: number;
  variant: EncoderVariant;
}

export async function encodeWebp(
  pixels: ImageData,
  options: Partial<EncodeOptions> & { variant?: EncoderVariant } = {},
): Promise<Encoded> {
  const { variant = await detectVariant(), ...overrides } = options;
  const encoder = await loadEncoder(variant);
  const settings: EncodeOptions = {
    ...defaultOptions,
    quality: DEFAULT_QUALITY,
    method: DEFAULT_METHOD,
    ...overrides,
  };
  const started = performance.now();
  const result = encoder.module.encode(pixels.data, pixels.width, pixels.height, settings);
  if (!result) throw new Error('WebP encoding failed');
  // Copy out of the WebAssembly heap, which the next encode may reuse.
  return { data: result.slice(), ms: performance.now() - started, variant };
}

export interface CanvasEncoded {
  type: string; // "image/png" means the platform cannot encode WebP
  size: number;
  ms: number;
}

// encodeWithCanvas is the built-in alternative, used only for comparison.
export async function encodeWithCanvas(pixels: ImageData, quality = DEFAULT_QUALITY): Promise<CanvasEncoded> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  ctx.putImageData(pixels, 0, 0);
  const started = performance.now();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality / 100));
  return { type: blob?.type ?? 'none', size: blob?.size ?? 0, ms: performance.now() - started };
}
