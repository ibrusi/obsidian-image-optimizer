import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ImageLibrary } from '../src/services/library.ts';
import { fingerprint, SourceIndex } from '../src/services/source-index.ts';
import { MemoryStorage, MemoryVault } from './fakes.ts';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

test('fingerprint is the SHA-256 of the bytes', async () => {
  assert.equal(await fingerprint(new TextEncoder().encode('abc').buffer as ArrayBuffer),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a missing, broken or foreign index opens empty', async () => {
  for (const data of [null, 'junk', { version: 2, sources: { [KEY_A]: 'x.webp' } }, { version: 1, sources: { short: 'x.webp', [KEY_A]: 42 } }]) {
    const storage = new MemoryStorage();
    storage.data = data;
    assert.equal((await SourceIndex.open(storage)).get(KEY_A), undefined);
  }
  const failing = { load: async () => { throw new Error('unreadable'); }, save: async () => {} };
  assert.equal((await SourceIndex.open(failing)).get(KEY_A), undefined);
});

test('entries survive a save and a reload; nothing is written without changes', async () => {
  const storage = new MemoryStorage();
  const index = await SourceIndex.open(storage);
  await index.save();
  assert.equal(storage.data, null, 'no write without changes');
  index.set(KEY_A, 'img/a.webp');
  await index.save();
  assert.equal((await SourceIndex.open(storage)).get(KEY_A), 'img/a.webp');
});

test('renames of files and folders, and deletions, are followed', async () => {
  const index = SourceIndex.empty(new MemoryStorage());
  index.set(KEY_A, 'img/a.webp');
  index.set(KEY_B, 'img/sub/b.webp');
  index.renamed('img/a.webp', 'img/first.webp');
  assert.equal(index.get(KEY_A), 'img/first.webp');
  index.renamed('img', 'pictures');
  assert.equal(index.get(KEY_A), 'pictures/first.webp');
  assert.equal(index.get(KEY_B), 'pictures/sub/b.webp');
  index.renamed('pic', 'other'); // a prefix of a name, not a parent folder
  assert.equal(index.get(KEY_A), 'pictures/first.webp');
  index.removed('pictures/sub');
  assert.equal(index.get(KEY_B), undefined);
  assert.equal(index.get(KEY_A), 'pictures/first.webp');
});

test('the library finds a saved original, never a missing or refused file', async () => {
  const vault = new MemoryVault();
  const library = new ImageLibrary(vault, SourceIndex.empty(new MemoryStorage()), true);
  const original = new Uint8Array([1, 2, 3]).buffer;
  const first = await library.find(original);
  assert.equal(first.path, null);
  await library.save(first.key, 'img', 'a', 'webp', new Uint8Array([9]).buffer);
  assert.equal((await library.find(original)).path, 'img/a.webp');
  assert.equal((await library.find(original, (path) => path !== 'img/a.webp')).path, null, 'refused');
  await vault.trash('img/a.webp');
  assert.equal((await library.find(original)).path, null, 'stale entry');
});

test('with reuse off nothing is looked up', async () => {
  const vault = new MemoryVault({ 'a.webp': new Uint8Array([9]).buffer });
  const index = SourceIndex.empty(new MemoryStorage());
  index.set(await fingerprint(new Uint8Array([1]).buffer), 'a.webp');
  const found = await new ImageLibrary(vault, index, false).find(new Uint8Array([1]).buffer);
  assert.deepEqual(found, { key: null, path: null });
});
