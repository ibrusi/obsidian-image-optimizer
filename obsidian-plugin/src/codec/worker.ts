// Entry point of the encoder worker. Built separately and embedded into
// main.js as source text (see scripts/worker-source.mjs).
import { Engine } from './engine.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
let engine: Promise<Engine> | null = null;

scope.onmessage = async ({ data: message }) => {
  if (message.type === 'init') {
    engine = Engine.create(message.wasm);
    try {
      scope.postMessage({ type: 'ready', variant: (await engine).variant });
    } catch (error) {
      scope.postMessage({ type: 'init-failed', error: errorText(error) });
    }
    return;
  }
  try {
    if (!engine) throw new Error('encoder not initialised');
    const ready = await engine;
    const started = performance.now();
    const webp = message.type === 'still'
      ? ready.encodeStill(new Uint8Array(message.rgba), message.width, message.height, message.options)
      : await ready.encodeAnimation(message.width, message.height, message.frames, message.options);
    const buffer = webp.buffer as ArrayBuffer;
    scope.postMessage({ type: 'done', id: message.id, webp: buffer, ms: performance.now() - started }, [buffer]);
  } catch (error) {
    scope.postMessage({ type: 'failed', id: message.id, error: errorText(error) });
  }
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
