// Runs inside the browser under test (Chromium = desktop/Android Obsidian,
// WebKit = iOS Obsidian) against the real WebAssembly encoders.
import { WASM } from '../../src/codec/assets.ts';
import { MainThreadCodec, WorkerCodec } from '../../src/codec/codec.ts';
import { Engine } from '../../src/codec/engine.ts';
import type { EncoderVariant } from '../../src/codec/protocol.ts';
import { decodeGif, scanGif } from '../../src/domain/gif.ts';
import animatedGif from '../fixtures/animated.gif';

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

// pixelsOf decodes WebP bytes with the browser's decoder.
async function pixelsOf(data: ArrayBuffer): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([data], { type: 'image/webp' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
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
  const options = { compression: 'lossy', quality: 40, method: 4 } as const;

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
    const cancelled = worker.encodeStill(copy(syntheticImage(3000, 2000)), { ...options, method: 6 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const outcome = await cancelled.then(() => 'finished', (e: Error) => e.name);
    check('cancel stops the encoder', outcome === 'AbortError', outcome);

    const after = await worker.encodeStill(copy(image), options);
    check('the worker restarts after a cancel', equal(after.data, viaWorker.data));

    const lossless = await worker.encodeStill(copy(image), { ...options, compression: 'lossless' });
    const decoded = await pixelsOf(lossless.data);
    check('lossless WebP is pixel-exact', decoded.data.every((v, i) => v === image.data[i]),
      `${lossless.data.byteLength} B lossless vs ${viaWorker.data.byteLength} B lossy`);

    await checkAnimation(check, worker, inThread);
  } finally {
    worker.dispose();
  }
  return { userAgent: navigator.userAgent, variant: worker.variant, checks };
};

type CheckFn = (name: string, ok: boolean, detail?: string) => void;

async function checkAnimation(check: CheckFn, worker: WorkerCodec, inThread: MainThreadCodec): Promise<void> {
  const bytes = new Uint8Array(animatedGif);
  const info = scanGif(bytes)!;
  const gif = decodeGif(bytes);
  check('GIF scan and decode agree on the frame count', gif.frames.length === info.frames && info.frames > 1, `${info.frames} frames`);

  // The browser's own decoder is the reference for compositing.
  const Decoder = (window as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (Decoder) {
    const decoder = new Decoder({ data: bytes, type: 'image/gif' });
    let mismatches = 0;
    for (let i = 0; i < gif.frames.length; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      const canvas = document.createElement('canvas');
      canvas.width = gif.width;
      canvas.height = gif.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      image.close();
      const reference = ctx.getImageData(0, 0, gif.width, gif.height).data;
      const ours = gif.frames[i].rgba;
      for (let p = 0; p < ours.length; p += 4) {
        const alphaDiffers = (ours[p + 3] === 0) !== (reference[p + 3] === 0);
        const colourDiffers = ours[p + 3] !== 0 && (ours[p] !== reference[p] || ours[p + 1] !== reference[p + 1] || ours[p + 2] !== reference[p + 2]);
        if (alphaDiffers || colourDiffers) mismatches++;
      }
    }
    decoder.close();
    check('GIF frames match the browser decoder pixel for pixel', mismatches === 0, `${mismatches} differing pixels`);
  } else {
    check('GIF frames match the browser decoder (ImageDecoder unavailable, skipped)', true);
  }

  const frames = () => gif.frames.map((f) => ({ rgba: f.rgba.slice().buffer, durationMs: f.durationMs }));
  const animation = () => ({ width: gif.width, height: gif.height, frames: frames() });
  const lossy = { compression: 'lossy', quality: 40 } as const;
  const viaWorker = await worker.encodeAnimation(animation(), lossy);
  const viaMain = await inThread.encodeAnimation(animation(), lossy);
  const chunks = riffChunks(new Uint8Array(viaWorker.data));
  const frameChunks = chunks.filter((c) => c === 'ANMF').length;
  check('animated WebP has an ANIM chunk and its frames', chunks.includes('ANIM') && frameChunks >= 2 && frameChunks <= gif.frames.length,
    `${frameChunks} frames, ${viaWorker.data.byteLength} B from a ${bytes.length} B GIF`);
  check('animated WebP: worker and main thread produce identical bytes', equal(viaWorker.data, viaMain.data));
  const bitmap = await createImageBitmap(new Blob([viaWorker.data], { type: 'image/webp' }));
  check('animated WebP decodes', bitmap.width === gif.width && bitmap.height === gif.height);
  bitmap.close();

  const lossless = await worker.encodeAnimation(animation(), { ...lossy, compression: 'lossless' });
  const first = await pixelsOf(lossless.data);
  const reference = gif.frames[0].rgba;
  let differing = 0;
  for (let p = 0; p < reference.length; p += 4) {
    // Colours under fully transparent pixels are free for the encoder.
    if (reference[p + 3] !== first.data[p + 3] ||
      (reference[p + 3] !== 0 && (reference[p] !== first.data[p] || reference[p + 1] !== first.data[p + 1] || reference[p + 2] !== first.data[p + 2]))) differing++;
  }
  check('lossless animated WebP keeps the first frame exactly', differing === 0,
    `${differing} differing pixels, ${lossless.data.byteLength} B lossless vs ${viaWorker.data.byteLength} B lossy`);
}

// riffChunks lists the top-level chunk types of a WebP file.
function riffChunks(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    types.push(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
    const size = view.getUint32(offset + 4, true);
    offset += 8 + size + (size & 1);
  }
  return types;
}
