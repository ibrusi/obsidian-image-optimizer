import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimensionsOf } from '../src/domain/dimensions.ts';

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

test('png, gif and bmp headers', () => {
  assert.deepEqual(dimensionsOf(png(4000, 3000), 'png'), { width: 4000, height: 3000 });
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xf0, 0x00, 0, 0, 0]);
  assert.deepEqual(dimensionsOf(gif, 'gif'), { width: 320, height: 240 });
  const bmp = new Uint8Array(30);
  new DataView(bmp.buffer).setInt32(18, 640, true);
  new DataView(bmp.buffer).setInt32(22, -480, true); // top-down bitmap
  assert.deepEqual(dimensionsOf(bmp, 'bmp'), { width: 640, height: 480 });
});

test('jpeg: skips APP segments and fill bytes up to the frame header', () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4, // APP1 (EXIF), 4 bytes of payload
    0xff, 0xff, // fill byte
    0xff, 0xc2, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, // SOF2 3000×4000
  ]);
  assert.deepEqual(dimensionsOf(jpeg, 'jpeg'), { width: 4000, height: 3000 });
});

test('truncated or unknown headers give null', () => {
  assert.equal(dimensionsOf(Uint8Array.from([0x89, 0x50]), 'png'), null);
  assert.equal(dimensionsOf(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'), null);
  assert.equal(dimensionsOf(new Uint8Array(40), 'webp'), null);
});

test('WebP dimensions from VP8X, VP8 and VP8L headers', () => {
  const riff = (chunk: string, payload: number[]) => Uint8Array.from([
      ...[...'RIFF'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[...'WEBP'].map((c) => c.charCodeAt(0)),
      ...[...chunk].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...payload,
    ]);
  // VP8X: flags, 3 reserved bytes, then width-1 and height-1 as 24-bit numbers.
  assert.deepEqual(dimensionsOf(riff('VP8X', [0x10, 0, 0, 0, 0x73, 0x04, 0, 0x3b, 0x03, 0]), 'webp'), { width: 1140, height: 828 });
  // VP8: frame tag, start code 9d 01 2a, then 14-bit width and height.
  assert.deepEqual(dimensionsOf(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x07, 0x38, 0x04]), 'webp'), { width: 1920, height: 1080 });
  // VP8L: signature 0x2f, then width-1 and height-1 in 14 bits each.
  const bits = (1439) | (899 << 14);
  assert.deepEqual(dimensionsOf(riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, bits >>> 24]), 'webp'), { width: 1440, height: 900 });
  assert.equal(dimensionsOf(riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'webp'), null, 'no start code');
});
