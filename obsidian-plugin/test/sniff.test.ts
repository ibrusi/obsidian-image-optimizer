import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionOf, imageTypeOf, isConvertible } from '../src/domain/sniff.ts';

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

test('SVG is recognized by its root element, HTML is not', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(imageTypeOf(bytes('<svg xmlns="http://www.w3.org/2000/svg" width="10"/>')), 'svg');
  assert.equal(imageTypeOf(bytes('﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>')), 'svg');
  assert.equal(imageTypeOf(bytes('  <SVG viewBox="0 0 1 1">')), 'svg');
  assert.equal(imageTypeOf(bytes('<!doctype html><html><body><svg></svg></body></html>')), null);
  assert.equal(imageTypeOf(bytes('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>')), null);
  assert.equal(imageTypeOf(bytes('<svgfoo>')), null);
  assert.equal(extensionOf('svg'), 'svg');
});

test('PDF is recognized by its header', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n%\u00e2\u00e3\n1 0 obj');
  assert.equal(imageTypeOf(pdf), 'pdf');
  assert.equal(extensionOf('pdf'), 'pdf');
  assert.equal(isConvertible('pdf'), false);
});
