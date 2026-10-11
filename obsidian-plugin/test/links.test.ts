import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findRemoteImages, replaceImages } from '../src/domain/links.ts';

const urls = (text: string) => findRemoteImages(text).map((i) => i.url);

test('finds remote Markdown embeds with titles, angle brackets and parentheses', () => {
  const text = [
    '![a](https://x.test/a.png)',
    '![b](https://x.test/b.jpg "Title")',
    '![c](<https://x.test/c d.png>)',
    '![d](https://en.wikipedia.org/wiki/File_(1).png)',
    '![[local.png]] ![e](local.png) [f](https://x.test/not-embed.png)',
  ].join('\n');
  assert.deepEqual(urls(text), [
    'https://x.test/a.png',
    'https://x.test/b.jpg',
    'https://x.test/c d.png',
    'https://en.wikipedia.org/wiki/File_(1).png',
  ]);
});

test('ignores code blocks, inline code, comments and escaped embeds', () => {
  const text = [
    '```md',
    '![in fence](https://x.test/1.png)',
    '```',
    '`![inline](https://x.test/2.png)`',
    '<!-- ![html](https://x.test/3.png) -->',
    '%% ![obsidian](https://x.test/4.png) %%',
    '\\![escaped](https://x.test/5.png)',
    '![real](https://x.test/6.png)',
  ].join('\n');
  assert.deepEqual(urls(text), ['https://x.test/6.png']);
});

test('an unclosed fence hides the rest of the note', () => {
  assert.deepEqual(urls('~~~\n![x](https://x.test/1.png)\n'), []);
});

test('stray backticks do not hide later embeds and stay linear', () => {
  assert.deepEqual(urls('a ` b\n\n![x](https://x.test/1.png)'), ['https://x.test/1.png']);

  const noisy = 'x `'.repeat(200_000) + '\n![x](https://x.test/1.png)';
  const started = performance.now();
  assert.deepEqual(urls(noisy), ['https://x.test/1.png']);
  assert.ok(performance.now() - started < 1000, 'parsing must not be quadratic');
});

test('replaceImages rewrites every embed of a URL and keeps the rest', () => {
  const text = 'A ![x](https://x.test/a.png) B ![y](https://x.test/a.png) C ![z](https://x.test/b.png)\n`![x](https://x.test/a.png)`';
  const result = replaceImages(text, new Map([['https://x.test/a.png', '![[a.webp]]']]));
  assert.equal(result, 'A ![[a.webp]] B ![[a.webp]] C ![z](https://x.test/b.png)\n`![x](https://x.test/a.png)`');
});
