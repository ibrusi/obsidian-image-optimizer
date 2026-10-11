import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveNew } from '../src/services/storage.ts';
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
