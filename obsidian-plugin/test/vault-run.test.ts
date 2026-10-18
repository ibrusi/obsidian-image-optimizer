import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Converted } from '../src/services/converter.ts';
import { RunStats } from '../src/services/stats.ts';
import { optimizeNotes, type Progress } from '../src/services/vault-run.ts';
import { FakeHttp, FakeLinks, FakeMetadata, memoryLibrary, MemoryVault, tagFor, testPng, testWebp } from './fakes.ts';

const PNG = (fill = 3) => testPng(32, 24, fill);
const A_TAG = await tagFor(PNG());
const P_TAG = await tagFor(PNG(4));

function context(vault: MemoryVault, http: FakeHttp, signal?: AbortSignal) {
  return {
    vault,
    links: new FakeLinks(),
    metadata: new FakeMetadata(vault),
    http,
    library: memoryLibrary(vault),
    // Each image encodes to its own bytes, as different pictures do.
    convert: async (data: ArrayBuffer): Promise<Converted> => ({ data: testWebp(32, 24, 40 + new Uint8Array(data)[100]), ext: 'webp', replaced: true, detail: 'ok' }),
    settings: { folder: 'Attachments', maxDownloadMB: 30, allowPrivateHosts: false, downloadPdf: false },
    stats: new RunStats(),
    flush: async () => {},
    ignoredFiles: new Set<string>(),
    signal,
  };
}

test('every note is processed, originals are retired once at the end', async () => {
  const vault = new MemoryVault({
    'a.md': '![](https://x.test/a.png)',
    'b.md': '![[p.png]]',
    'c.md': 'no images',
    'p.png': PNG(4), // another image than a.png
  });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG() } });
  const progress: Progress[] = [];
  const ctx = context(vault, http);
  await optimizeNotes(['a.md', 'b.md', 'c.md'], ctx, { convertLocal: true, onProgress: (p) => progress.push(p) });

  assert.equal(vault.text('a.md'), `![[Attachments/a-${A_TAG}.webp]]`);
  assert.equal(vault.text('b.md'), `![[p-${P_TAG}.webp]]`);
  assert.deepEqual(vault.trashed, ['p.png']);
  assert.deepEqual(progress.map((p) => p.done), [0, 1, 2, 3]);
  assert.equal(ctx.stats.converted, 2);
  const notes = ctx.stats.lines.filter((line) => line.startsWith('note: '));
  assert.deepEqual(notes, ['note: a.md (1000 B → 43 B, -96%)', 'note: b.md (1000 B → 44 B, -96%)'], 'the log names each note with images before its lines');
  assert.ok(ctx.stats.lines.indexOf('note: a.md (1000 B → 43 B, -96%)') < ctx.stats.lines.findIndex((line) => line.startsWith('https://x.test/a.png')));
});

test('a note header logs the combined size and savings of all its images, and omits them when none were saved', async () => {
  const vault = new MemoryVault({
    'multi.md': '![](https://x.test/a.png) ![[p.png]]',
    'failed.md': '![](https://x.test/missing.png)',
    'p.png': PNG(4),
  });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG() } });
  const ctx = context(vault, http);
  await optimizeNotes(['multi.md', 'failed.md'], ctx, { convertLocal: true, onProgress: () => {} });
  const notes = ctx.stats.lines.filter((line) => line.startsWith('note: '));
  assert.deepEqual(notes, ['note: multi.md (2.0 KB → 87 B, -96%)', 'note: failed.md']);
});

test('a note whose images are all done already is not named in the log', async () => {
  const vault = new MemoryVault({ 'done.md': '![[pic.webp]]', 'pic.webp': testWebp(8, 8) });
  const ctx = context(vault, new FakeHttp({}));
  await optimizeNotes(['done.md'], ctx, { convertLocal: true, onProgress: () => {} });
  assert.deepEqual(ctx.stats.lines, []);
});

test('local images are left alone when convertLocal is off', async () => {
  const vault = new MemoryVault({ 'b.md': '![[p.png]]', 'p.png': PNG() });
  await optimizeNotes(['b.md'], context(vault, new FakeHttp({})), { convertLocal: false, onProgress: () => {} });
  assert.equal(vault.text('b.md'), '![[p.png]]');
});

test('a cancelled run keeps finished notes and still retires their originals', async () => {
  const vault = new MemoryVault({ 'a.md': '![[p.png]]', 'b.md': '![[q.png]]', 'p.png': PNG(), 'q.png': PNG() });
  const controller = new AbortController();
  const ctx = context(vault, new FakeHttp({}), controller.signal);
  const run = optimizeNotes(['a.md', 'b.md'], ctx, {
    convertLocal: true,
    onProgress: (p) => { if (p.done === 1) controller.abort(); },
  });
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(vault.text('a.md'), `![[p-${A_TAG}.webp]]`);
  assert.equal(vault.text('b.md'), '![[q.png]]');
  assert.deepEqual(vault.trashed, ['p.png']);
});
