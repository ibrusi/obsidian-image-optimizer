import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageType } from '../src/domain/sniff.ts';
import type { Converted } from '../src/services/converter.ts';
import { processRemoteImages, type RemoteContext } from '../src/services/remote-images.ts';
import { RunStats } from '../src/services/stats.ts';
import { FakeHttp, FakeLinks, MemoryVault } from './fakes.ts';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(992).fill(1)]).buffer;
const HTML = new TextEncoder().encode('<!doctype html><title>Hotlinking denied</title>').buffer as ArrayBuffer;
const WEBP = new Uint8Array(100).buffer;

function context(vault: MemoryVault, http: FakeHttp, overrides: Partial<RemoteContext> = {}): RemoteContext {
  return {
    vault,
    links: new FakeLinks(),
    http,
    convert: async (_data: ArrayBuffer, _type: ImageType): Promise<Converted> => ({ data: WEBP, ext: 'webp', replaced: true, detail: 'ok' }),
    settings: { folder: 'Attachments', maxDownloadMB: 30, allowPrivateHosts: false },
    stats: new RunStats(),
    ...overrides,
  };
}

test('web images are saved into the folder and every embed is rewritten with its own alias', async () => {
  const note = 'habr/post.md';
  const vault = new MemoryVault({
    [note]: 'A ![first|300](https://x.test/a.png) B <img src="https://x.test/a.png" width="120"> C ![bad](https://x.test/page)\n',
  });
  const http = new FakeHttp({
    'https://x.test/a.png': { status: 200, body: PNG },
    'https://x.test/page': { status: 200, body: HTML },
  });
  const ctx = context(vault, http);

  await processRemoteImages(note, ctx);

  assert.equal(vault.text(note),
    'A ![[habr/Attachments/a.webp|first|300]] B ![[habr/Attachments/a.webp|120]] C ![bad](https://x.test/page)\n');
  assert.deepEqual(http.requests, ['https://x.test/a.png', 'https://x.test/page'], 'each URL is downloaded once');
  assert.equal(ctx.stats.converted, 1);
  assert.equal(ctx.stats.failed, 1, 'an HTML page is not an image');
  assert.match(ctx.stats.lines.join('\n'), /not an image/);
});

test('a second run has nothing left to do', async () => {
  const note = 'n.md';
  const vault = new MemoryVault({ [note]: '![](https://x.test/a.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  await processRemoteImages(note, context(vault, http));
  const after = vault.text(note);
  await processRemoteImages(note, context(vault, http));
  assert.equal(vault.text(note), after);
  assert.equal(http.requests.length, 1);
});

test('private hosts are refused without a request', async () => {
  const vault = new MemoryVault({ 'n.md': '![](http://192.168.1.1/cam.jpg)' });
  const http = new FakeHttp({});
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.equal(http.requests.length, 0);
  assert.equal(ctx.stats.failed, 1);
});

test('an embed removed during the download leaves no orphan file', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const ctx = context(vault, http, {
    convert: async () => {
      vault.files.set('n.md', 'the user deleted the image');
      return { data: WEBP, ext: 'webp', replaced: true, detail: 'ok' };
    },
  });
  await processRemoteImages('n.md', ctx);
  assert.deepEqual(vault.trashed, ['Attachments/a.webp']);
  assert.equal(vault.text('n.md'), 'the user deleted the image');
});

test('only limits the run to the given URLs', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.png) ![](https://x.test/b.png)' });
  const http = new FakeHttp({ 'https://x.test/b.png': { status: 200, body: PNG } });
  await processRemoteImages('n.md', context(vault, http), new Set(['https://x.test/b.png']));
  assert.deepEqual(http.requests, ['https://x.test/b.png']);
});

test('cancelling stops the run before the image in progress is written', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.png) ![](https://x.test/b.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG }, 'https://x.test/b.png': { status: 200, body: PNG } });
  const controller = new AbortController();
  const ctx = context(vault, http, { signal: controller.signal });
  const convert = ctx.convert;
  ctx.convert = async (data, type) => {
    const result = await convert(data, type);
    controller.abort();
    return result;
  };
  await assert.rejects(processRemoteImages('n.md', ctx), { name: 'AbortError' });
  assert.equal(vault.text('n.md'), '![](https://x.test/a.png) ![](https://x.test/b.png)', 'aborted before the first commit');
});
