import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Converted } from '../src/services/converter.ts';
import { savePastedImage } from '../src/services/pasted-images.ts';
import { RunStats } from '../src/services/stats.ts';
import { memoryLibrary, MemoryVault } from './fakes.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(500).fill(9)]).buffer;
const now = new Date(2026, 9, 11, 15, 30, 5);

test('a pasted screenshot is saved as WebP into the folder of the note', async () => {
  const vault = new MemoryVault({ 'notes/a.md': '' });
  const path = await savePastedImage(PNG, 'image.png', 'notes/a.md', {
    vault,
    library: memoryLibrary(vault),
    convert: async (): Promise<Converted> => ({ data: new ArrayBuffer(10), ext: 'webp', replaced: true, detail: 'ok' }),
    settings: { folder: 'Attachments' },
    stats: new RunStats(),
  }, now);
  assert.equal(path, 'notes/Attachments/Pasted image 20261011153005.webp');
});

test('a failure while converting saves the original instead of losing the image', async () => {
  const vault = new MemoryVault();
  const stats = new RunStats();
  const path = await savePastedImage(PNG, 'diagram.png', 'a.md', {
    vault,
    library: memoryLibrary(vault),
    convert: async () => { throw new Error('out of memory'); },
    settings: { folder: '/' },
    stats,
  }, now);
  assert.equal(path, 'diagram.png');
  assert.equal(vault.files.get('diagram.png'), PNG);
  assert.match(stats.lines.join('\n'), /saved unconverted \(out of memory\)/);
});

test('non-images are not handled', async () => {
  const vault = new MemoryVault();
  const path = await savePastedImage(new TextEncoder().encode('%PDF-1.7 ......').buffer as ArrayBuffer, 'doc.pdf', 'a.md', {
    vault, library: memoryLibrary(vault), convert: async () => { throw new Error('unreachable'); }, settings: { folder: '' }, stats: new RunStats(),
  });
  assert.equal(path, null);
  assert.equal(vault.files.size, 0);
});

test('pasting the same image again links the file saved the first time', async () => {
  const vault = new MemoryVault({ 'a.md': '' });
  const library = memoryLibrary(vault);
  let encodes = 0;
  const ctx = () => ({
    vault,
    library,
    convert: async (): Promise<Converted> => ({ data: new Uint8Array(10 + ++encodes).buffer, ext: 'webp', replaced: true, detail: 'ok' }),
    settings: { folder: '' },
    stats: new RunStats(),
  });
  const first = await savePastedImage(PNG, 'image.png', 'a.md', ctx(), now);
  const second = await savePastedImage(PNG, 'image.png', 'a.md', ctx(), new Date(2026, 9, 12));
  assert.equal(second, first);
  assert.equal(encodes, 1);
});
