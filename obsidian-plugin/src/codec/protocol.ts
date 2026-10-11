// Messages between the plugin and the encoder worker.

export interface WasmBinaries {
  stillScalar: ArrayBuffer;
  stillSimd: ArrayBuffer;
}

export interface StillOptions {
  quality: number;
  method: number;
}

export type EncoderVariant = 'simd' | 'scalar';

export type ToWorker =
  | { type: 'init'; wasm: WasmBinaries }
  | { type: 'still'; id: number; width: number; height: number; rgba: ArrayBuffer; options: StillOptions };

export type FromWorker =
  | { type: 'ready'; variant: EncoderVariant }
  | { type: 'init-failed'; error: string }
  | { type: 'done'; id: number; webp: ArrayBuffer; ms: number }
  | { type: 'failed'; id: number; error: string };
