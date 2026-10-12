import assert from 'node:assert/strict';
import { test } from 'node:test';
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

function deps(outputSize: number, calls: string[] = []): ConvertDeps {
  return {
    decode: async () => { calls.push('decode'); return { width: 1, height: 1, data: new Uint8ClampedArray(4) } as ImageData; },
    encodeStill: async (_p, options) => { calls.push(`encode q${options.quality} m${options.method}`); return { data: new ArrayBuffer(outputSize) }; },
    encodeAnimation: async (a, options) => {
      calls.push(`animate ${a.width}x${a.height}x${a.frames.length} q${options.quality} ${a.frames.map((f) => f.durationMs).join(',')}`);
      return { data: new ArrayBuffer(outputSize) };
    },
  };
}

test('converts when the saving is large enough', async () => {
  const calls: string[] = [];
  const result = await convert(png(10, 10), 'png', settings, deps(300, calls));
  assert.equal(result.replaced, true);
  assert.equal(result.ext, 'webp');
  assert.equal(result.data.byteLength, 300);
  assert.deepEqual(calls, ['decode', 'encode q40 m4']);
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

test('animated GIFs become animated WebP with their frame timing', async () => {
  const calls: string[] = [];
  const result = await convert(animatedGif(3), 'gif', settings, deps(10, calls));
  assert.equal(result.replaced, true);
  assert.equal(result.ext, 'webp');
  assert.deepEqual(calls, ['animate 20x20x3 q40 50,50,50']);
});

test('single-frame GIFs are encoded as still images', async () => {
  const calls: string[] = [];
  await convert(animatedGif(1), 'gif', settings, deps(10, calls));
  assert.deepEqual(calls, ['decode', 'encode q40 m4']);
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
