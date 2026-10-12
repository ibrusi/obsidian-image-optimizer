import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Compression } from '../src/domain/compression.ts';
import { convert, type ConvertDeps, type ConvertSettings } from '../src/services/converter.ts';
import { buildGif } from './gif-builder.ts';

const settings: ConvertSettings = { quality: 40, method: 4, minSavingsPercent: 5, gifMode: 'animated-webp', maxMegapixels: 50 };

function png(width: number, height: number, size = 1000): ArrayBuffer {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b.buffer;
}

type Sizes = number | Record<Compression, number>;

// deps fakes the codec. Decoded images have `colors` distinct colours; every
// encoding returns `sizes` bytes, or the size given for its compression.
function deps(sizes: Sizes, calls: string[] = [], colors = 10): ConvertDeps {
  const output = (compression: Compression) => new ArrayBuffer(typeof sizes === 'number' ? sizes : sizes[compression]);
  return {
    decode: async () => {
      calls.push('decode');
      const pixels = new Uint32Array(colors);
      for (let i = 0; i < colors; i++) pixels[i] = i;
      return { width: colors, height: 1, data: new Uint8ClampedArray(pixels.buffer) } as ImageData;
    },
    encodeStill: async (_p, options) => {
      calls.push(`encode ${options.compression} q${options.quality} m${options.method}`);
      return { data: output(options.compression) };
    },
    encodeAnimation: async (a, options) => {
      calls.push(`animate ${options.compression} ${a.width}x${a.height}x${a.frames.length} q${options.quality} ${a.frames.map((f) => f.durationMs).join(',')}`);
      return { data: output(options.compression) };
    },
  };
}

function jpeg(): ArrayBuffer {
  const b = new Uint8Array(1000);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0a, 0x00, 0x0a]);
  return b.buffer;
}

test('a screenshot is encoded lossless once when that is worth it', async () => {
  const calls: string[] = [];
  const result = await convert(png(10, 10), 'png', settings, deps(300, calls, 200));
  assert.equal(result.replaced, true);
  assert.equal(result.ext, 'webp');
  assert.equal(result.data.byteLength, 300);
  assert.match(result.detail, /^lossless,/);
  assert.deepEqual(calls, ['decode', 'encode lossless q40 m4']);
});

test('a guess without saving falls back to the other compression', async () => {
  const calls: string[] = [];
  const result = await convert(png(10, 10), 'png', settings, deps({ lossless: 990, lossy: 300 }, calls, 200));
  assert.equal(result.data.byteLength, 300);
  assert.match(result.detail, /^lossy,/);
  assert.deepEqual(calls, ['decode', 'encode lossless q40 m4', 'decode', 'encode lossy q40 m4']);
});

test('a photo is encoded lossy once', async () => {
  const calls: string[] = [];
  const result = await convert(png(10, 10), 'png', settings, deps(300, calls, 20_000));
  assert.match(result.detail, /^lossy,/);
  assert.deepEqual(calls, ['decode', 'encode lossy q40 m4']);
});

test('an unclear image tries both and keeps the smaller', async () => {
  for (const [sizes, winner] of [[{ lossless: 200, lossy: 400 }, 'lossless'], [{ lossless: 400, lossy: 200 }, 'lossy']] as const) {
    const calls: string[] = [];
    const result = await convert(png(10, 10), 'png', settings, deps(sizes, calls, 3000));
    assert.equal(result.data.byteLength, 200);
    assert.match(result.detail, new RegExp(`^${winner},`));
    assert.equal(calls.length, 4);
  }
});

test('JPEG is only encoded lossy, whatever its colours', async () => {
  const calls: string[] = [];
  const result = await convert(jpeg(), 'jpeg', settings, deps(300, calls, 5));
  assert.equal(result.replaced, true, result.detail);
  assert.deepEqual(calls, ['decode', 'encode lossy q40 m4']);
});

test('cancelling between attempts stops before the next one', async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const fake = deps(300, calls, 3000);
  const encodeStill = fake.encodeStill;
  fake.encodeStill = async (...args) => { const r = await encodeStill(...args); controller.abort(); return r; };
  await assert.rejects(convert(png(10, 10), 'png', settings, fake, controller.signal), { name: 'AbortError' });
  assert.deepEqual(calls, ['decode', 'encode lossless q40 m4']);
});

test('keeps the original below the minimum saving', async () => {
  const input = png(10, 10);
  const result = await convert(input, 'png', settings, deps(960));
  assert.equal(result.replaced, false);
  assert.equal(result.ext, 'png');
  assert.equal(result.data, input);
  assert.match(result.detail, /less than 5%/);
});

test('refuses oversized images before decoding them', async () => {
  const calls: string[] = [];
  const result = await convert(png(10000, 8000), 'png', settings, deps(10, calls));
  assert.equal(result.replaced, false);
  assert.match(result.detail, /80\.0 MP/);
  assert.deepEqual(calls, []);
});

test('WebP is never re-encoded', async () => {
  const calls: string[] = [];
  const result = await convert(new ArrayBuffer(50), 'webp', settings, deps(10, calls));
  assert.equal(result.replaced, false);
  assert.deepEqual(calls, []);
});

const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 0, 0]];
const animatedGif = (frames: number, size = 20) => buildGif(size, size, palette,
  Array.from({ length: frames }, (_, i) => ({ width: size, height: size, indices: new Array(size * size).fill(i % 4), delayCs: 5 }))).buffer as ArrayBuffer;

// richGif has 256 colours and changes `share` of its pixels every frame.
function richGif(frames: number, share: number, size = 20): ArrayBuffer {
  const colors = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255]);
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  let indices = Array.from({ length: size * size }, (_, i) => i % 256);
  const list = [];
  for (let f = 0; f < frames; f++) {
    if (f > 0) indices = indices.map((v) => (random() % 1000 < share * 1000 ? (v + 1 + (random() % 254)) % 256 : v));
    list.push({ width: size, height: size, indices, delayCs: 5 });
  }
  return buildGif(size, size, colors, list).buffer as ArrayBuffer;
}

test('animated GIFs become animated WebP with their frame timing', async () => {
  const calls: string[] = [];
  const result = await convert(animatedGif(3), 'gif', settings, deps(10, calls));
  assert.equal(result.replaced, true);
  assert.equal(result.ext, 'webp');
  // Four flat colours: a graphic, encoded lossless once.
  assert.match(result.detail, /3 frames, lossless,/);
  assert.deepEqual(calls, ['animate lossless 20x20x3 q40 50,50,50']);
});

test('a video-like animation is encoded lossy, falling back to lossless without saving', async () => {
  const calls: string[] = [];
  const video = await convert(richGif(3, 0.9), 'gif', settings, deps(10, calls));
  assert.match(video.detail, /3 frames, lossy,/);
  assert.equal(calls.length, 1);
  const fallback = await convert(richGif(3, 0.9), 'gif', settings, deps({ lossy: 1e6, lossless: 10 }));
  assert.match(fallback.detail, /3 frames, lossless,/);
});

test('an animation with moderate change tries both and keeps the smaller', async () => {
  const calls: string[] = [];
  const result = await convert(richGif(3, 0.2), 'gif', settings, deps({ lossless: 300, lossy: 100 }, calls));
  assert.match(result.detail, /3 frames, lossy,/);
  assert.deepEqual(calls.map((c) => c.split(' ')[1]), ['lossless', 'lossy']);
});

test('single-frame GIFs are encoded as still images', async () => {
  const calls: string[] = [];
  await convert(animatedGif(1), 'gif', settings, deps(10, calls));
  assert.deepEqual(calls, ['decode', 'encode lossless q40 m4']);
});

test('GIFs are kept with gifMode keep, or when the animation is over the budget', async () => {
  const calls: string[] = [];
  assert.equal((await convert(animatedGif(3), 'gif', { ...settings, gifMode: 'keep' }, deps(10, calls))).replaced, false);
  const huge = await convert(animatedGif(30, 200), 'gif', { ...settings, maxMegapixels: 1 }, deps(10, calls));
  assert.equal(huge.replaced, false);
  assert.match(huge.detail, /30 frames/);
  assert.deepEqual(calls, [], 'nothing decoded or encoded');
});

test('an animation within the megapixel limit is converted: frames count once', async () => {
  const calls: string[] = [];
  // 35 frames of 100×100 = 0.35 MP, the shape of a typical GIF scaled down.
  const result = await convert(animatedGif(35, 100), 'gif', { ...settings, maxMegapixels: 0.36 }, deps(10, calls));
  assert.equal(result.replaced, true, result.detail);
  assert.equal(calls.length, 1);
});
