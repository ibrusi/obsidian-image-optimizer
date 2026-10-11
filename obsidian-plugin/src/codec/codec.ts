import WORKER_SOURCE from 'virtual:worker-source';
import { Engine } from './engine.ts';
import type { EncoderVariant, FromWorker, StillOptions, ToWorker, WasmBinaries } from './protocol.ts';

export interface Encoded {
  data: ArrayBuffer;
  ms: number;
}

// Codec encodes images. Calls are serialised: one image in memory at a time
// keeps phones within their memory limits.
export interface Codec {
  readonly mode: 'worker' | 'main-thread';
  readonly variant: EncoderVariant;
  /** Takes ownership of pixels: its buffer may be transferred and detached. */
  encodeStill(pixels: ImageData, options: StillOptions, signal?: AbortSignal): Promise<Encoded>;
  dispose(): void;
}

const STARTUP_TIMEOUT_MS = 10_000;

// createCodec starts the encoder in a Web Worker so the interface stays
// responsive, and falls back to the main thread where workers from Blob URLs
// are not allowed.
export async function createCodec(wasm: WasmBinaries, onFallback?: (reason: string) => void): Promise<Codec> {
  try {
    return await WorkerCodec.start(wasm);
  } catch (error) {
    onFallback?.(error instanceof Error ? error.message : String(error));
    return new MainThreadCodec(await Engine.create(wasm));
  }
}

// Serial runs tasks one after another, whatever the previous one's outcome.
class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class MainThreadCodec implements Codec {
  readonly mode = 'main-thread' as const;
  readonly variant: EncoderVariant;
  private readonly engine: Engine;
  private readonly serial = new Serial();

  constructor(engine: Engine) {
    this.engine = engine;
    this.variant = engine.variant;
  }

  encodeStill(pixels: ImageData, options: StillOptions, signal?: AbortSignal): Promise<Encoded> {
    return this.serial.run(async () => {
      signal?.throwIfAborted();
      const started = performance.now();
      const webp = this.engine.encodeStill(pixels.data, pixels.width, pixels.height, options);
      return { data: webp.buffer as ArrayBuffer, ms: performance.now() - started };
    });
  }

  dispose(): void {}
}

interface Pending {
  resolve(encoded: Encoded): void;
  reject(error: Error): void;
}

export class WorkerCodec implements Codec {
  readonly mode = 'worker' as const;
  readonly variant: EncoderVariant;
  private worker: Worker | null;
  private readonly wasm: WasmBinaries;
  private readonly pending = new Map<number, Pending>();
  private readonly serial = new Serial();
  private nextId = 1;

  private constructor(worker: Worker, variant: EncoderVariant, wasm: WasmBinaries) {
    this.worker = worker;
    this.variant = variant;
    this.wasm = wasm;
    this.listen(worker);
  }

  static async start(wasm: WasmBinaries): Promise<WorkerCodec> {
    const { worker, variant } = await spawn(wasm);
    return new WorkerCodec(worker, variant, wasm);
  }

  encodeStill(pixels: ImageData, options: StillOptions, signal?: AbortSignal): Promise<Encoded> {
    return this.serial.run(async () => {
      signal?.throwIfAborted();
      const worker = await this.ensureWorker();
      const id = this.nextId++;
      const rgba = pixels.data.buffer as ArrayBuffer;
      const result = new Promise<Encoded>((resolve, reject) => this.pending.set(id, { resolve, reject }));
      // Cancelling stops the encoder mid-image: the worker is terminated and
      // started again for the next request.
      const abort = () => this.restart(new DOMException('Cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      const message: ToWorker = { type: 'still', id, width: pixels.width, height: pixels.height, rgba, options };
      worker.postMessage(message, [rgba]);
      try {
        return await result;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    });
  }

  dispose(): void {
    this.restart(new Error('encoder stopped'));
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    const { worker } = await spawn(this.wasm);
    this.listen(worker);
    this.worker = worker;
    return worker;
  }

  private listen(worker: Worker): void {
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.type !== 'done' && data.type !== 'failed') return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.type === 'done') pending.resolve({ data: data.webp, ms: data.ms });
      else pending.reject(new Error(data.error));
    };
    worker.onerror = (event) => this.restart(new Error(`encoder crashed: ${event.message || 'unknown error'}`));
  }

  private restart(reason: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}

function spawn(wasm: WasmBinaries): Promise<{ worker: Worker; variant: EncoderVariant }> {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return new Promise((resolve, reject) => {
    // The URL is revoked only once the worker answered: Safari may still be
    // loading the script right after the constructor returns.
    const settle = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
    const fail = (reason: string) => {
      settle();
      worker.terminate();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail('the encoder worker did not start'), STARTUP_TIMEOUT_MS);
    worker.onerror = (event) => fail(`the encoder worker failed to start: ${event.message || 'blocked'}`);
    worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.type === 'ready') {
        settle();
        resolve({ worker, variant: data.variant });
      } else if (data.type === 'init-failed') {
        fail(data.error);
      }
    };
    // The binaries are copied, not transferred: the plugin keeps them to
    // restart the worker after a cancellation.
    const init: ToWorker = { type: 'init', wasm };
    worker.postMessage(init);
  });
}
