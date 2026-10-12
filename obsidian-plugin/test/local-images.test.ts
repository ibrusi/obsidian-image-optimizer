import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Converted } from '../src/services/converter.ts';
import { LocalImages, type LocalContext } from '../src/services/local-images.ts';
import { RunStats } from '../src/services/stats.ts';
import { FakeLinks, FakeMetadata, MemoryVault } from './fakes.ts';

const PNG = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(992).fill(7)]).buffer;
const WEBP = new Uint8Array(100).buffer;

function setup(files: Record<string, ArrayBuffer | string>, overrides: Partial<LocalContext> = {}) {
  const vault = new MemoryVault(files);
  const flushed: string[] = [];
  const ctx: LocalContext = {
    vault,
    links: new FakeLinks(),
    metadata: new FakeMetadata(vault),
    convert: async (): Promise<Converted> => ({ data: WEBP, ext: 'webp', replaced: true, detail: 'ok' }),
    stats: new RunStats(),
    flush: async (path) => { flushed.push(path); },
    ignoredFiles: new Set(['image-optimizer-log.md']),
    ...overrides,
  };
  return { vault, ctx, flushed, local: new LocalImages(ctx) };
}

test('every link to the original is rewritten and the original goes to the trash', async () => {
  const { vault, ctx, local, flushed } = setup({
    'notes/a.md': '![[photo.png|200]] text',
    'notes/b.md': 'See [the photo](../img/photo.png) and ![photo.png](../img/photo.png)',
    'notes/c.md': '---\ncover: "[[img/photo.png]]"\n---\nno embed here',
    'img/photo.png': PNG(),
    'image-optimizer-log.md': 'img/photo.png → img/photo.webp',
  });

  await local.processNote('notes/a.md');
  await local.retireOriginals();

  assert.equal(vault.text('notes/a.md'), '![[img/photo.webp|200]] text');
  assert.equal(vault.text('notes/b.md'), 'See [[img/photo.webp|the photo]] and ![[img/photo.webp]]',
    'an alias that is only the old file name is dropped');
  assert.equal(vault.text('notes/c.md'), '---\ncover: "[[img/photo.webp]]"\n---\nno embed here');
  assert.ok(vault.files.has('img/photo.webp'));
  assert.deepEqual(vault.trashed, ['img/photo.png'], 'the log note does not count as a mention');
  assert.deepEqual(new Set(flushed), new Set(['notes/a.md', 'notes/b.md', 'notes/c.md']));
  assert.equal(ctx.stats.converted, 1);
});

test('an original still mentioned in a canvas stays', async () => {
  const { vault, local, ctx } = setup({
    'a.md': '![[photo.png]]',
    'board.canvas': '{"nodes":[{"type":"file","file":"photo.png"}]}',
    'photo.png': PNG(),
  });
  await local.processNote('a.md');
  await local.retireOriginals();
  assert.equal(vault.text('a.md'), '![[photo.webp]]');
  assert.ok(vault.files.has('photo.png'));
  assert.deepEqual(vault.trashed, []);
  assert.match(ctx.stats.lines.join('\n'), /still mentioned/);
});

test('a note that cannot be rewritten keeps the original and the image is not converted twice', async () => {
  const { vault, local, ctx } = setup({
    'a.md': '![[photo.png]]',
    'locked.md': '![[photo.png]]',
    'photo.png': PNG(),
  });
  const process = vault.process.bind(vault);
  vault.process = async (path, fn) => {
    if (path === 'locked.md') throw new Error('permission denied');
    return process(path, fn);
  };
  await local.processNote('a.md');
  await local.processNote('locked.md');
  await local.retireOriginals();
  assert.ok(vault.files.has('photo.png'), 'kept: locked.md still points at it');
  assert.equal([...vault.files.keys()].filter((p) => p.endsWith('.webp')).length, 1);
  assert.equal(ctx.stats.failed, 1);
});

test('images that are not worth converting and WebP files are left alone', async () => {
  const { vault, local, ctx } = setup({
    'a.md': '![[photo.png]] ![[done.webp]] ![[doc.pdf]]',
    'photo.png': PNG(),
    'done.webp': WEBP,
    'doc.pdf': 'pdf',
  }, {
    convert: async (data): Promise<Converted> => ({ data, ext: 'png', replaced: false, detail: 'WebP saves less than 5%' }),
  });
  await local.processNote('a.md');
  await local.retireOriginals();
  assert.equal(vault.text('a.md'), '![[photo.png]] ![[done.webp]] ![[doc.pdf]]');
  assert.equal(ctx.stats.kept, 1);
  assert.deepEqual(vault.trashed, []);
});

test('a different WebP with the same name next to the original is avoided', async () => {
  const other = new Uint8Array(100).fill(1).buffer;
  const { vault, local } = setup({ 'a.md': '![[photo.png]]', 'photo.png': PNG(), 'photo.webp': other });
  await local.processNote('a.md');
  assert.equal(vault.text('a.md'), '![[photo-1.webp]]');
  assert.equal(vault.files.get('photo.webp'), other, 'the existing WebP is untouched');
});

test('an identical WebP already next to the original is reused, not duplicated', async () => {
  const existing = WEBP.slice(0);
  const { vault, local } = setup({ 'a.md': '![[photo.png]]', 'photo.png': PNG(), 'photo.webp': existing });
  await local.processNote('a.md');
  await local.retireOriginals();
  assert.equal(vault.text('a.md'), '![[photo.webp]]');
  assert.equal(vault.files.get('photo.webp'), existing);
  assert.deepEqual([...vault.files.keys()].filter((p) => p.endsWith('.webp')), ['photo.webp']);
  assert.deepEqual(vault.trashed, ['photo.png']);
});
