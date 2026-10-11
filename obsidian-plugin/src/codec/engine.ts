import { simd } from 'wasm-feature-detect';
import type { EncodeOptions, WebPModule } from '@jsquash/webp/codec/enc/webp_enc.js';
import { defaultOptions } from '@jsquash/webp/meta.js';
import { initEmscriptenModule } from '@jsquash/webp/utils.js';
import scalarFactory from '@jsquash/webp/codec/enc/webp_enc.js';
import simdFactory from '@jsquash/webp/codec/enc/webp_enc_simd.js';
import animationFactory, { type AnimationModule } from 'wasm-webp/dist/esm/webp-wasm.js';
import type { AnimationFrame, AnimationOptions, EncoderVariant, StillOptions, WasmBinaries } from './protocol.ts';

// Engine is the WebAssembly encoder itself. It runs inside the worker and,
// when a worker cannot be started, on the main thread. It receives the .wasm
// bytes instead of importing them, so the worker bundle stays small.
export class Engine {
  readonly variant: EncoderVariant;
  private readonly still: WebPModule;
  private readonly animationWasm: ArrayBuffer;
  private animation: Promise<AnimationModule> | null = null;

  private constructor(variant: EncoderVariant, still: WebPModule, animationWasm: ArrayBuffer) {
    this.variant = variant;
    this.still = still;
    this.animationWasm = animationWasm;
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
    return new Engine(variant, still, wasm.animation);
  }

  encodeStill(rgba: Uint8ClampedArray<ArrayBuffer> | Uint8Array<ArrayBuffer>, width: number, height: number, options: StillOptions): Uint8Array {
    const settings: EncodeOptions = { ...defaultOptions, quality: options.quality, method: options.method };
    const result = this.still.encode(rgba, width, height, settings);
    if (!result) throw new Error('WebP encoding failed');
    // Copy out of the WebAssembly heap, which the next call may reuse.
    return result.slice();
  }

  // encodeAnimation encodes full-canvas RGBA frames into an animated WebP
  // with libwebp's WebPAnimEncoder, which stores only what changes between
  // frames. Its module is compiled on the first animation only.
  async encodeAnimation(width: number, height: number, frames: AnimationFrame[], options: AnimationOptions): Promise<Uint8Array> {
    this.animation ??= animationFactory({
      wasmBinary: new Uint8Array(this.animationWasm),
      locateFile: (path: string) => path,
    });
    const module = await this.animation;
    const vector = new module.VectorWebPAnimationFrame();
    try {
      for (const frame of frames) {
        vector.push_back({
          data: new Uint8Array(frame.rgba),
          duration: frame.durationMs,
          config: { lossless: 0, quality: options.quality },
          has_config: true,
        });
      }
      const result = module.encodeAnimation(width, height, true, vector);
      if (!result || result.length === 0) throw new Error('animated WebP encoding failed');
      return result.slice();
    } finally {
      vector.delete(); // frames live in the WebAssembly heap until deleted
    }
  }
}
