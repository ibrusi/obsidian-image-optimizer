declare module '*.wasm' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

declare module 'wasm-webp/dist/esm/webp-wasm.js' {
  interface AnimationFrameInput {
    data: Uint8Array;
    duration: number;
    config: { lossless: number; quality: number };
    has_config: boolean;
  }
  export interface AnimationModule {
    VectorWebPAnimationFrame: new () => { push_back(frame: AnimationFrameInput): void; delete(): void };
    encodeAnimation(width: number, height: number, hasAlpha: boolean, frames: unknown): Uint8Array | null;
  }
  const factory: (options: { wasmBinary: Uint8Array; locateFile(path: string): string }) => Promise<AnimationModule>;
  export default factory;
}

declare module '*.gif' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}

declare module 'virtual:worker-source' {
  const source: string;
  export default source;
}
