import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeGif, scanGif } from '../src/domain/gif.ts';
import { buildGif } from './gif-builder.ts';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const palette = [RED, GREEN, BLUE, [0, 0, 0]];

// pixel returns [r, g, b, a] of a frame.
const pixel = (rgba: Uint8Array, width: number, x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('scanGif counts frames without decoding, also when truncated', () => {
  const frames = [0, 1, 2].map(() => ({ width: 2, height: 2, indices: [0, 1, 2, 0] }));
  assert.deepEqual(scanGif(buildGif(2, 2, palette, frames)), { width: 2, height: 2, frames: 3 });
  const truncated = buildGif(2, 2, palette, frames, false);
  assert.equal(scanGif(truncated.subarray(0, truncated.length - 5))?.frames, 2);
  assert.equal(scanGif(new TextEncoder().encode('<html>')), null);
});

test('a single frame decodes to exact pixels', () => {
  const gif = decodeGif(buildGif(2, 2, palette, [{ width: 2, height: 2, indices: [0, 1, 2, 3] }]));
  assert.equal(gif.frames.length, 1);
  const f = gif.frames[0].rgba;
  assert.deepEqual([pixel(f, 2, 0, 0), pixel(f, 2, 1, 0), pixel(f, 2, 0, 1), pixel(f, 2, 1, 1)],
    [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 255]]);
});

test('transparent pixels show the previous frame; disposal 2 clears; disposal 3 restores', () => {
  const gif = decodeGif(buildGif(2, 1, palette, [
    { width: 2, height: 1, indices: [0, 0] }, // red red, keep
    { width: 2, height: 1, indices: [3, 1], transparent: 3, disposal: 2 }, // red green, then clear
    { width: 1, height: 1, left: 1, indices: [2], disposal: 3 }, // _ blue, then restore
    { width: 1, height: 1, indices: [1] }, // green _
  ]));
  const at = (frame: number) => [pixel(gif.frames[frame].rgba, 2, 0, 0), pixel(gif.frames[frame].rgba, 2, 1, 0)];
  assert.deepEqual(at(0), [[255, 0, 0, 255], [255, 0, 0, 255]]);
  assert.deepEqual(at(1), [[255, 0, 0, 255], [0, 255, 0, 255]]);
  assert.deepEqual(at(2), [[0, 0, 0, 0], [0, 0, 255, 255]], 'frame 1 was cleared to transparent');
  assert.deepEqual(at(3), [[0, 255, 0, 255], [0, 0, 0, 0]], 'frame 2 was undone');
});

test('interlaced rows and local colour tables', () => {
  const rows = Array.from({ length: 10 }, (_, y) => y % 4);
  const gif = decodeGif(buildGif(1, 10, palette, [
    { width: 1, height: 10, indices: rows, interlaced: true },
    { width: 1, height: 1, indices: [0], palette: [[9, 8, 7], [0, 0, 0]] },
  ]));
  const column = (frame: number) => Array.from({ length: 10 }, (_, y) => pixel(gif.frames[frame].rgba, 1, 0, y)[0]);
  assert.deepEqual(column(0), rows.map((i) => palette[i][0]));
  assert.deepEqual(pixel(gif.frames[1].rgba, 1, 0, 0), [9, 8, 7, 255]);
});

test('delays: 0 and 1 hundredths become 100 ms like in browsers', () => {
  const gif = decodeGif(buildGif(1, 1, palette, [
    { width: 1, height: 1, indices: [0], delayCs: 0 },
    { width: 1, height: 1, indices: [0], delayCs: 1 },
    { width: 1, height: 1, indices: [0], delayCs: 7 },
  ]));
  assert.deepEqual(gif.frames.map((f) => f.durationMs), [100, 100, 70]);
});

test('large frames span many LZW clear codes and sub-blocks', () => {
  const indices = Array.from({ length: 300 * 200 }, (_, i) => (i * 7) % 4);
  const gif = decodeGif(buildGif(300, 200, palette, [{ width: 300, height: 200, indices }]));
  const f = gif.frames[0].rgba;
  for (const i of [0, 1, 255, 256, 511, 59999]) {
    assert.deepEqual(pixel(f, 300, i % 300, Math.floor(i / 300)).slice(0, 3), palette[indices[i]], `pixel ${i}`);
  }
});

test('frames reaching outside the screen are clipped, corrupt data does not throw past the frame', () => {
  const gif = decodeGif(buildGif(2, 2, palette, [{ width: 3, height: 3, left: 1, top: 1, indices: new Array(9).fill(2) }]));
  assert.deepEqual(pixel(gif.frames[0].rgba, 2, 1, 1), [0, 0, 255, 255]);
  assert.deepEqual(pixel(gif.frames[0].rgba, 2, 0, 0), [0, 0, 0, 0]);
});
