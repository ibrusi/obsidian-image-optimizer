// Runs inside the browser under test (Chromium = desktop/Android Obsidian,
// WebKit = iOS Obsidian) against the real WebAssembly encoders.
import { WASM } from '../../src/codec/assets.ts';
import { MainThreadCodec, WorkerCodec } from '../../src/codec/codec.ts';
import { Engine } from '../../src/codec/engine.ts';
import type { EncoderVariant } from '../../src/codec/protocol.ts';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  userAgent: string;
  variant: EncoderVariant;
  checks: Check[];
}

function syntheticImage(width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2b5876');
  gradient.addColorStop(1, '#f7b733');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  let seed = 42; // deterministic noise, like sensor grain
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed % 25) - 12;
    pixels.data[i] += noise;
    pixels.data[i + 1] += noise;
    pixels.data[i + 2] += noise;
  }
  return pixels;
}

const copy = (img: ImageData) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

async function decodesTo(data: ArrayBuffer, width: number, height: number): Promise<boolean> {
  const bytes = new Uint8Array(data);
  const header = String.fromCharCode(...bytes.subarray(0, 4)) + String.fromCharCode(...bytes.subarray(8, 12));
  if (header !== 'RIFFWEBP') return false;
  const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
  const ok = bitmap.width === width && bitmap.height === height;
  bitmap.close();
  return ok;
}

function equal(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((v, i) => v === y[i]);
}

(window as unknown as { run: () => Promise<Report> }).run = async () => {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  const image = syntheticImage(1200, 800);
  const options = { quality: 40, method: 4 };

  const worker = await WorkerCodec.start(WASM);
  const inThread = new MainThreadCodec(await Engine.create(WASM));
  try {
    const viaWorker = await worker.encodeStill(copy(image), options);
    const viaMain = await inThread.encodeStill(copy(image), options);
    check('worker output decodes', await decodesTo(viaWorker.data, image.width, image.height),
      `${viaWorker.data.byteLength} B in ${Math.round(viaWorker.ms)} ms`);
    check('worker and main thread produce identical bytes', equal(viaWorker.data, viaMain.data),
      `${viaWorker.data.byteLength} vs ${viaMain.data.byteLength} B`);

    const both = await Promise.all([1, 2, 3].map(() => worker.encodeStill(copy(image), options)));
    check('queued requests all complete', both.every((r) => equal(r.data, viaWorker.data)));

    const controller = new AbortController();
    const cancelled = worker.encodeStill(copy(syntheticImage(3000, 2000)), { quality: 40, method: 6 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const outcome = await cancelled.then(() => 'finished', (e: Error) => e.name);
    check('cancel stops the encoder', outcome === 'AbortError', outcome);

    const after = await worker.encodeStill(copy(image), options);
    check('the worker restarts after a cancel', equal(after.data, viaWorker.data));
  } finally {
    worker.dispose();
  }
  return { userAgent: navigator.userAgent, variant: worker.variant, checks };
};
