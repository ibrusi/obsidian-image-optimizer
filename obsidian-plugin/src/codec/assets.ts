import stillScalar from '@jsquash/webp/codec/enc/webp_enc.wasm';
import stillSimd from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';
import type { WasmBinaries } from './protocol.ts';

// The encoders are embedded into main.js: on mobile a plugin cannot load
// files that sit next to it.
export const WASM: WasmBinaries = {
  stillScalar: stillScalar.buffer,
  stillSimd: stillSimd.buffer,
};
