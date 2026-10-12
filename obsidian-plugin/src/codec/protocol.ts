// Messages between the plugin and the encoder worker.

import type { Compression } from '../domain/compression.ts';

export interface WasmBinaries {
  stillScalar: ArrayBuffer;
  stillSimd: ArrayBuffer;
  animation: ArrayBuffer;
}

export interface StillOptions {
  compression: Compression;
  /** Lossy quality, 1–100; lossless encoding ignores it. */
  quality: number;
  method: number;
}

export interface AnimationOptions {
  compression: Compression;
  /** Lossy quality, 1–100; lossless encoding ignores it. */
  quality: number;
}

export interface AnimationFrame {
  /** RGBA pixels of the whole canvas. */
  rgba: ArrayBuffer;
  durationMs: number;
}

export type EncoderVariant = 'simd' | 'scalar';

export type ToWorker =
  | { type: 'init'; wasm: WasmBinaries }
  | { type: 'still'; id: number; width: number; height: number; rgba: ArrayBuffer; options: StillOptions }
  | { type: 'animation'; id: number; width: number; height: number; frames: AnimationFrame[]; options: AnimationOptions };

export type FromWorker =
  | { type: 'ready'; variant: EncoderVariant }
  | { type: 'init-failed'; error: string }
  | { type: 'done'; id: number; webp: ArrayBuffer; ms: number }
  | { type: 'failed'; id: number; error: string };
