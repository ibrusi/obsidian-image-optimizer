import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageTypeOf, isConvertible } from '../src/sniff.ts';

const pad = (head: number[] | string) => {
  const bytes = typeof head === 'string' ? Array.from(head, (c) => c.charCodeAt(0)) : head;
  return Uint8Array.from([...bytes, ...new Array(16).fill(0)]);
};

test('imageTypeOf recognises images by magic bytes', () => {
  assert.equal(imageTypeOf(pad([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(imageTypeOf(pad([0x89, 0x50, 0x4e, 0x47])), 'png');
  assert.equal(imageTypeOf(pad('GIF89a')), 'gif');
  assert.equal(imageTypeOf(pad('BM')), 'bmp');
  assert.equal(imageTypeOf(pad('RIFF\0\0\0\0WEBP')), 'webp');
  assert.equal(imageTypeOf(pad('<!doctype html>')), null);
  assert.equal(imageTypeOf(Uint8Array.from([0xff, 0xd8])), null);
});

test('only still raster formats are converted', () => {
  assert.equal(isConvertible('jpeg'), true);
  assert.equal(isConvertible('gif'), false);
  assert.equal(isConvertible('webp'), false);
});
