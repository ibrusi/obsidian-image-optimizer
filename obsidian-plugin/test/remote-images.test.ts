import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ImageType } from '../src/domain/sniff.ts';
import type { Converted } from '../src/services/converter.ts';
import { processRemoteImages, type RemoteContext } from '../src/services/remote-images.ts';
import { RunStats } from '../src/services/stats.ts';
import { FakeHttp, FakeLinks, memoryLibrary, MemoryVault, tagFor, testPng, testWebp } from './fakes.ts';

const PNG = testPng(32, 24, 1);
const HTML = new TextEncoder().encode('<!doctype html><title>Hotlinking denied</title>').buffer as ArrayBuffer;
const WEBP = testWebp(32, 24);
const A = `a-${await tagFor(PNG)}.webp`;

function context(vault: MemoryVault, http: FakeHttp, overrides: Partial<RemoteContext> = {}): RemoteContext {
  return {
    vault,
    links: new FakeLinks(),
    http,
    library: memoryLibrary(vault),
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
    `A ![[habr/Attachments/${A}|first|300]] B ![[habr/Attachments/${A}|120]] C ![bad](https://x.test/page)\n`);
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
  assert.deepEqual(vault.trashed, [`Attachments/${A}`]);
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

test('the same image in a second note reuses the saved file', async () => {
  const vault = new MemoryVault({ 'a.md': '![](https://x.test/a.png)', 'b.md': '![](https://x.test/a.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const ctx = context(vault, http);
  await processRemoteImages('a.md', ctx);
  await processRemoteImages('b.md', ctx);
  assert.equal(vault.text('a.md'), `![[Attachments/${A}]]`);
  assert.equal(vault.text('b.md'), `![[Attachments/${A}]]`);
  assert.deepEqual([...vault.files.keys()].filter((p) => p.endsWith('.webp')), [`Attachments/${A}`]);
  assert.match(ctx.stats.lines.join('\n'), /reused/);
});

test('a reused file is never trashed, even when the embed disappeared meanwhile', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.png)', 'Attachments/a.webp': WEBP });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const ctx = context(vault, http, {
    convert: async () => {
      vault.files.set('n.md', 'the user deleted the image');
      return { data: WEBP, ext: 'webp', replaced: true, detail: 'ok' };
    },
  });
  await processRemoteImages('n.md', ctx);
  assert.deepEqual(vault.trashed, []);
  assert.ok(vault.files.has('Attachments/a.webp'));
});

test('the same image added again after the encoding changed reuses the first file, without encoding', async () => {
  const vault = new MemoryVault({ 'a.md': '![](https://x.test/a.png)', 'b.md': '![](https://x.test/a.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const library = memoryLibrary(vault);
  let encodes = 0;
  // Each encoding gives different bytes, as after a change of settings.
  const convert = async (): Promise<Converted> => ({ data: testWebp(32, 24, 50 + ++encodes), ext: 'webp', replaced: true, detail: 'ok' });
  await processRemoteImages('a.md', context(vault, http, { library, convert }));
  const ctx = context(vault, http, { library, convert });
  await processRemoteImages('b.md', ctx);
  assert.equal(vault.text('b.md'), `![[Attachments/${A}]]`);
  assert.equal(encodes, 1);
  assert.deepEqual([...vault.files.keys()].filter((p) => p.endsWith('.webp')), [`Attachments/${A}`]);
  assert.match(ctx.stats.lines.join('\n'), /already in the vault, reused/);
});

test('with reuse off the same image is saved again', async () => {
  const vault = new MemoryVault({ 'a.md': '![](https://x.test/a.png)', 'b.md': '![](https://x.test/a.png)' });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const library = memoryLibrary(vault, false);
  await processRemoteImages('a.md', context(vault, http, { library }));
  await processRemoteImages('b.md', context(vault, http, { library }));
  assert.equal(vault.text('b.md'), '![[Attachments/a-1.webp]]');
});

test('another device finds a file synced from the first one by its name alone', async () => {
  // The first device saved the image; only the vault itself was synced.
  const vault = new MemoryVault({ 'b.md': '![](https://x.test/a.png)', [`Attachments/${A}`]: testWebp(32, 24, 77) });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  let encodes = 0;
  const ctx = context(vault, http, { convert: async () => { encodes++; return { data: WEBP, ext: 'webp', replaced: true, detail: 'ok' }; } });
  await processRemoteImages('b.md', ctx);
  assert.equal(vault.text('b.md'), `![[Attachments/${A}]]`);
  assert.equal(encodes, 0);
  assert.equal([...vault.files.keys()].filter((p) => p.endsWith('.webp')).length, 1);
});

test('a file with the tag but another size is a collision and is not reused', async () => {
  const vault = new MemoryVault({ 'b.md': '![](https://x.test/a.png)', [`Attachments/${A}`]: testWebp(640, 480) });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  await processRemoteImages('b.md', context(vault, http));
  assert.equal(vault.text('b.md'), `![[Attachments/${A.replace('.webp', '-1.webp')}]]`);
  assert.equal(vault.files.size, 3, 'the other image is untouched');
});

test('the same picture arriving as another original reuses the WebP it encodes to', async () => {
  // A picture copied in a browser comes back from the clipboard as another
  // PNG; decoded and encoded, it gives the same WebP as the download.
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.png)', 'Attachments/Pasted image-0123456789abcdef.webp': WEBP });
  const http = new FakeHttp({ 'https://x.test/a.png': { status: 200, body: PNG } });
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.equal(vault.text('n.md'), '![[Attachments/Pasted image-0123456789abcdef.webp]]');
  assert.match(ctx.stats.lines.join('\n'), /identical file already in the vault, reused/);
});

test('images are requested like a browser on the source page', async () => {
  const page = 'https://x.test/2025/05/post/';
  const vault = new MemoryVault({ 'n.md': `---\nsource: "${page}"\n---\n![](https://static.x.test/a.png) ![](https://cdn.y.test/b.png)` });
  const http = new FakeHttp({});
  await processRemoteImages('n.md', context(vault, http));
  assert.match(http.headers[0]?.Accept ?? '', /image\/webp/);
  assert.equal(http.headers[0]?.Referer, page, 'the source page for its own site');
  assert.equal(http.headers[1]?.Referer, 'https://cdn.y.test/', 'the image site for another one');
});

test('a .webp the site no longer serves is replaced by its original', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/up/cover.webp)' });
  const http = new FakeHttp({
    'https://x.test/up/cover.jpeg': { status: 200, body: HTML },
    'https://x.test/up/cover.png': { status: 200, body: PNG },
  });
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.deepEqual(http.requests, [
    'https://x.test/up/cover.webp',
    'https://x.test/up/cover.jpg',
    'https://x.test/up/cover.jpeg',
    'https://x.test/up/cover.png',
  ]);
  assert.equal(vault.text('n.md'), `![[Attachments/cover-${await tagFor(PNG)}.webp]]`);
  assert.equal(ctx.stats.failed, 0);
  assert.ok(ctx.stats.lines.some((line) => line.includes('from https://x.test/up/cover.png')), 'the log names the URL used');
});

test('a missing .webp without an original keeps its link and reports the 404', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/up/cover.webp)' });
  const http = new FakeHttp({ 'https://x.test/up/cover.webp': { status: 500, body: new ArrayBuffer(0) } });
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.deepEqual(http.requests, ['https://x.test/up/cover.webp'], 'only a 404 or 403 looks for the original');
  assert.equal(vault.text('n.md'), '![](https://x.test/up/cover.webp)');
  assert.equal(ctx.stats.failed, 1);

  const gone = new MemoryVault({ 'n.md': '![](https://x.test/up/cover.webp)' });
  const ctx404 = context(gone, new FakeHttp({}));
  await processRemoteImages('n.md', ctx404);
  assert.ok(ctx404.stats.lines.some((line) => line.endsWith('cover.webp: HTTP 404')));
});

test('a request blocked with a Referer is sent again without it', async () => {
  const vault = new MemoryVault({ 'n.md': '---\nsource: https://x.test/post\n---\n![](https://x.test/a.png)' });
  let calls = 0;
  const http = new FakeHttp({});
  http.get = async (url, headers) => {
    http.requests.push(url);
    http.headers.push(headers);
    if (calls++ === 0) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
    return { status: 200, body: PNG };
  };
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.equal(http.headers[0]?.Referer, 'https://x.test/post');
  assert.equal(http.headers[1]?.Referer, undefined);
  assert.equal(ctx.stats.failed, 0);

  // The client refused a Referer once: the next image goes without one.
  await vault.process('n.md', (text) => `${text} ![](https://x.test/b.png)`);
  await processRemoteImages('n.md', ctx);
  assert.equal(http.requests.length, 3);
  assert.equal(http.headers[2]?.Referer, undefined);
});

test('a .webp that storage refuses as AccessDenied (403) is taken in its original format', async () => {
  const denied = new TextEncoder().encode('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>').buffer as ArrayBuffer;
  const vault = new MemoryVault({ 'n.md': '![](https://static.x.test/images/1/0.webp)' });
  const http = new FakeHttp({
    'https://static.x.test/images/1/0.webp': { status: 403, body: denied, headers: { 'content-type': 'application/xml' } },
    'https://static.x.test/images/1/0.jpg': { status: 403, body: denied },
    'https://static.x.test/images/1/0.jpeg': { status: 403, body: denied },
    'https://static.x.test/images/1/0.png': { status: 200, body: PNG },
  });
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  assert.equal(vault.text('n.md'), `![[Attachments/0-${await tagFor(PNG)}.webp]]`);
  assert.equal(ctx.stats.failed, 0);
});

test('a .webp the site does not give is never replaced by a local file with the same name', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/pic1.webp)' });
  await vault.createBinary('Attachments/pic1.webp', WEBP);
  const ctx = context(vault, new FakeHttp({ 'https://x.test/pic1.webp': { status: 403, body: new ArrayBuffer(0) } }));
  await processRemoteImages('n.md', ctx);
  assert.equal(vault.text('n.md'), '![](https://x.test/pic1.webp)');
  assert.equal(ctx.stats.failed, 1);
});

test('a failed download logs every request with its answer', async () => {
  const vault = new MemoryVault({ 'n.md': '---\nsource: https://x.test/post\n---\n![](https://static.x.test/11.webp)' });
  const page = new TextEncoder().encode('<html><head><style>p{}</style></head><body><h1>403 Forbidden</h1><p>nginx</p></body></html>').buffer as ArrayBuffer;
  const http = new FakeHttp({
    'https://static.x.test/11.webp': { status: 403, body: page, headers: { 'content-type': 'text/html', server: 'nginx', 'set-cookie': 'secret=1' } },
  });
  const ctx = context(vault, http);
  await processRemoteImages('n.md', ctx);
  const at = ctx.stats.lines.indexOf('failed https://static.x.test/11.webp: HTTP 403');
  assert.ok(at >= 0, ctx.stats.lines.join('\n'));
  const detail = ctx.stats.lines[at + 1];
  assert.ok(detail.startsWith('  GET https://static.x.test/11.webp (Referer https://x.test/post) → 403 in '), detail);
  assert.match(detail, /content-type: text\/html; server: nginx; \d+ bytes; body: "403 Forbidden nginx"$/);
  assert.doesNotMatch(detail, /secret/, 'cookies are not logged');
});

test('a 404 .webp logs the original it tried as well', async () => {
  const vault = new MemoryVault({ 'n.md': '![](https://x.test/a.webp)' });
  const ctx = context(vault, new FakeHttp({}));
  await processRemoteImages('n.md', ctx);
  const details = ctx.stats.lines.filter((line) => line.startsWith('  GET '));
  assert.deepEqual(details.map((line) => line.split(' ')[3]), [
    'https://x.test/a.webp', 'https://x.test/a.jpg', 'https://x.test/a.jpeg', 'https://x.test/a.png', 'https://x.test/a.gif',
  ]);
});
