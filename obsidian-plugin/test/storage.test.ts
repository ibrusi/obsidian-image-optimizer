import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveNew, store } from '../src/services/storage.ts';
import { MemoryVault } from './fakes.ts';

const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

test('saveNew creates the folder and never overwrites', async () => {
  const vault = new MemoryVault({ 'notes/Attachments/pic.webp': bytes('user file') });
  const path = await saveNew(vault, 'notes/Attachments', 'Pic', 'webp', bytes('new'));
  assert.equal(path, 'notes/Attachments/Pic-1.webp');
  assert.equal(new TextDecoder().decode(await vault.readBinary('notes/Attachments/pic.webp')), 'user file');

  const fresh = await saveNew(vault, 'img', 'a', 'webp', bytes('x'));
  assert.equal(fresh, 'img/a.webp');
});

test('saveNew retries when a name is taken between check and write', async () => {
  const vault = new MemoryVault();
  const create = vault.createBinary.bind(vault);
  let raced = false;
  vault.createBinary = async (path, data) => {
    if (!raced) { raced = true; vault.put(path, bytes('sync client')); }
    return create(path, data);
  };
  assert.equal(await saveNew(vault, '', 'a', 'webp', bytes('x')), 'a-1.webp');
});

test('store reuses a byte-identical file of the same name family', async () => {
  const vault = new MemoryVault({
    'img/Pic.webp': bytes('other image'),
    'img/pic-1.webp': bytes('same image'),
    'img/picture.webp': bytes('same image'),
  });
  assert.deepEqual(await store(vault, 'img', 'pic', 'webp', bytes('same image'), true), { path: 'img/pic-1.webp', created: false });
  assert.equal(vault.files.size, 3, 'nothing written');
});

test('store writes a new file when only the name or only the size matches', async () => {
  const vault = new MemoryVault({ 'img/pic.webp': bytes('aaaa'), 'img/pic.png': bytes('bbbb') });
  assert.deepEqual(await store(vault, 'img', 'pic', 'webp', bytes('abcd'), true), { path: 'img/pic-1.webp', created: true });
  assert.equal(new TextDecoder().decode(await vault.readBinary('img/pic.webp')), 'aaaa', 'same size, different bytes: untouched');
  assert.deepEqual(await store(vault, 'img', 'pic', 'webp', bytes('bbbb'), true), { path: 'img/pic-2.webp', created: true },
    'another extension is not the same file');
});

test('store always writes a new file when reuse is off', async () => {
  const vault = new MemoryVault({ 'img/pic.webp': bytes('same image') });
  assert.deepEqual(await store(vault, 'img', 'pic', 'webp', bytes('same image'), false), { path: 'img/pic-1.webp', created: true });
});

test('store reuses identical bytes anywhere in the vault, from the target folder first', async () => {
  const vault = new MemoryVault({
    'other/pasted.webp': bytes('same image'),
    'img/zzz.webp': bytes('same image'),
    'img/size.webp': bytes('same sizeX'),
  });
  assert.deepEqual(await store(vault, 'img', 'pic', 'webp', bytes('same image'), true), { path: 'img/zzz.webp', created: false });
  assert.deepEqual(await store(vault, 'new', 'pic', 'webp', bytes('same image'), true), { path: 'img/zzz.webp', created: false });
});

test('store reads only files of the same size and extension', async () => {
  const vault = new MemoryVault({ 'a.webp': bytes('1234'), 'b.png': bytes('abcd'), 'c.webp': bytes('abcdef') });
  const read: string[] = [];
  const readBinary = vault.readBinary.bind(vault);
  vault.readBinary = async (path) => { read.push(path); return readBinary(path); };
  assert.equal((await store(vault, '', 'x', 'webp', bytes('abcd'), true)).created, true);
  assert.deepEqual(read, ['a.webp']);
});
