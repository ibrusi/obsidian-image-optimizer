import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convert, type ConvertDeps, type ConvertSettings } from '../src/services/converter.ts';

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
