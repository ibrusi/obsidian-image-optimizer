import { simd } from 'wasm-feature-detect';
import type { EncodeOptions, WebPModule } from '@jsquash/webp/codec/enc/webp_enc.js';
import { defaultOptions } from '@jsquash/webp/meta.js';
import { initEmscriptenModule } from '@jsquash/webp/utils.js';
import scalarFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import simdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import type { EncoderVariant, StillOptions, WasmBinaries } from './protocol.ts';

// Engine is the WebAssembly encoder itself. It runs inside the worker and,
// when a worker cannot be started, on the main thread. It receives the .wasm
// bytes instead of importing them, so the worker bundle stays small.
export class Engine {
  readonly variant: EncoderVariant;
  private readonly still: WebPModule;

  private constructor(variant: EncoderVariant, still: WebPModule) {
    this.variant = variant;
    this.still = still;
  }

  static async create(wasm: WasmBinaries): Promise<Engine> {
    const variant: EncoderVariant = (await simd()) ? 'simd' : 'scalar';
    return Engine.createVariant(wasm, variant);
  }

  static async createVariant(wasm: WasmBinaries, variant: EncoderVariant): Promise<Engine> {
    const bytes = variant === 'simd' ? wasm.stillSimd : wasm.stillScalar;
    const factory = variant === 'simd' ? simdFactory : scalarFactory;
    const compiled = await WebAssembly.compile(bytes);
    // locateFile stops the Emscripten glue from deriving the .wasm URL from
    // import.meta.url, which does not exist in the plugin bundle.
    const still = await initEmscriptenModule(factory, compiled, { locateFile: (path: string) => path });
    return new Engine(variant, still);
  }

  encodeStill(rgba: Uint8ClampedArray<ArrayBuffer> | Uint8Array<ArrayBuffer>, width: number, height: number, options: StillOptions): Uint8Array {
    const settings: EncodeOptions = { ...defaultOptions, quality: options.quality, method: options.method };
    const result = this.still.encode(rgba, width, height, settings);
    if (!result) throw new Error('WebP encoding failed');
    // Copy out of the WebAssembly heap, which the next call may reuse.
    return result.slice();
  }
}
