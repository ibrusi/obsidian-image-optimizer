import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Converted } from '../src/services/converter.ts';
import { RunStats } from '../src/services/stats.ts';
import { optimizeNotes, type Progress } from '../src/services/vault-run.ts';
import { FakeHttp, FakeLinks, FakeMetadata, MemoryVault } from './fakes.ts';

const PNG = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(992).fill(3)]).buffer;
const WEBP = new Uint8Array(10).buffer;

function context(vault: MemoryVault, http: FakeHttp, signal?: AbortSignal) {
  return {
    vault,
    links: new FakeLinks(),
    metadata: new FakeMetadata(vault),
    http,
    convert: async (): Promise<Converted> => ({ data: WEBP, ext: 'webp', replaced: true, detail: 'ok' }),
    settings: { folder: 'Attachments', maxDownloadMB: 30, allowPrivateHosts: false, reuseIdentical: true },
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
    'p.png': PNG(),
  });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG() } });
  const progress: Progress[] = [];
  const ctx = context(vault, http);
  await optimizeNotes(['a.md', 'b.md', 'c.md'], ctx, { convertLocal: true, onProgress: (p) => progress.push(p) });

  assert.equal(vault.text('a.md'), '![[Attachments/a.webp]]');
  assert.equal(vault.text('b.md'), '![[p.webp]]');
  assert.deepEqual(vault.trashed, ['p.png']);
  assert.deepEqual(progress.map((p) => p.done), [0, 1, 2, 3]);
  assert.equal(ctx.stats.converted, 2);
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
  assert.equal(vault.text('a.md'), '![[p.webp]]');
  assert.equal(vault.text('b.md'), '![[q.png]]');
  assert.deepEqual(vault.trashed, ['p.png']);
});
