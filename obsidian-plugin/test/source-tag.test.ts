import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TAG_LENGTH, tagOf, tagOfFingerprint, withTag } from '../src/domain/source-tag.ts';
import { fingerprint } from '../src/services/library.ts';
import { memoryLibrary, MemoryVault } from './fakes.ts';

const T = '3fa9c2e1b7d0';

test('fingerprint is the SHA-256 of the bytes; the tag is its start', async () => {
  const hex = await fingerprint(new TextEncoder().encode('abc').buffer as ArrayBuffer);
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(tagOfFingerprint(hex), 'ba7816bf8f01');
  assert.equal(TAG_LENGTH, 12);
});

test('withTag adds a tag, replacing one the stem already carries', () => {
  assert.equal(withTag('photo', T), `photo-${T}`);
  assert.equal(withTag(`shot-${T}`, 'aaaaaaaaaaaa'), 'shot-aaaaaaaaaaaa');
  assert.equal(withTag(`shot-${T}-2`, T), `shot-${T}`);
  assert.equal(withTag('photo-2024', T), `photo-2024-${T}`, 'a short number is not a tag');
});

test('tagOf reads the tag of a file name', () => {
  assert.equal(tagOf(`photo-${T}.webp`), T);
  assert.equal(tagOf(`Pasted image 20261011153005-${T}-1.png`), T, 'with a suffix for a taken name');
  assert.equal(tagOf('photo.webp'), null);
  assert.equal(tagOf(`photo-${T.toUpperCase()}.webp`), null, 'tags are lower-case hex');
  assert.equal(tagOf(`photo-${T}x.webp`), null);
  assert.equal(tagOf(`photo-${T}`), null, 'no extension');
});

test('find prefers WebP, honours accept and does nothing with reuse off', async () => {
  const original = new Uint8Array([1, 2, 3]).buffer;
  const tag = tagOfFingerprint(await fingerprint(original));
  const vault = new MemoryVault({
    [`b/x-${tag}.png`]: original,
    [`a/x-${tag}.webp`]: new Uint8Array([9]).buffer,
    'a/other-000000000000.webp': new Uint8Array([9]).buffer,
  });
  assert.deepEqual(await memoryLibrary(vault).find(original), { tag, path: `a/x-${tag}.webp` });
  assert.equal((await memoryLibrary(vault).find(original, (p) => !p.endsWith('.webp'))).path, `b/x-${tag}.png`);
  assert.deepEqual(await memoryLibrary(vault, false).find(original), { tag: null, path: null });
});

test('save writes stem-tag.ext and reuses a pre-tag file with the same bytes', async () => {
  const vault = new MemoryVault({ 'img/old.webp': new Uint8Array([5]).buffer });
  const library = memoryLibrary(vault);
  assert.deepEqual(await library.save(T, 'img', 'pic', 'webp', new Uint8Array([7]).buffer), { path: `img/pic-${T}.webp`, created: true });
  assert.deepEqual(await library.save(T, 'img', 'old', 'webp', new Uint8Array([5]).buffer), { path: 'img/old.webp', created: false });
  assert.deepEqual(await memoryLibrary(vault, false).save(null, 'img', 'pic', 'webp', new Uint8Array([7]).buffer),
    { path: 'img/pic.webp', created: true }, 'no tag with reuse off');
});
