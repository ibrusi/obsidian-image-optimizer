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
  const result = replaceImages(text, (i) => (i.url === 'https://x.test/a.png' ? `![[a.webp|${i.alt}]]` : undefined));
  assert.equal(result, 'A ![[a.webp|x]] B ![[a.webp|y]] C ![z](https://x.test/b.png)\n`![x](https://x.test/a.png)`');
});

test('finds <img> tags with src, lazy data-src, entities, alt and width', () => {
  const text = [
    '<img src="https://x.test/a.png?w=1&amp;h=2" alt="A" width="300">',
    "<IMG data-src='https://x.test/lazy.jpg' src='data:image/gif;base64,R0lGOD'>",
    '<img src="/relative.png"> <img alt="no source">',
    '`<img src="https://x.test/code.png">`',
  ].join('\n');
  const images = findRemoteImages(text);
  assert.deepEqual(images.map((i) => [i.kind, i.url, i.alt, i.width]), [
    ['html', 'https://x.test/a.png?w=1&h=2', 'A', '300'],
    ['html', 'https://x.test/lazy.jpg', '', undefined],
  ]);
});

test('markdown and html embeds come back in document order and are both replaced', () => {
  const text = '<img src="https://x.test/b.png"> then ![a](https://x.test/a.png)';
  assert.deepEqual(urls(text), ['https://x.test/b.png', 'https://x.test/a.png']);
  const names: Record<string, string> = { 'https://x.test/b.png': '![[b.webp]]', 'https://x.test/a.png': '![[a.webp]]' };
  const result = replaceImages(text, (i) => names[i.url]);
  assert.equal(result, '![[b.webp]] then ![[a.webp]]');
});

test('YouTube videos and tweets embedded as images are not images', () => {
  const text = [
    '![](https://www.youtube.com/watch?v=ql-uncsqoAU)',
    '![](https://youtu.be/ql-uncsqoAU)',
    '![](https://m.youtube.com/shorts/abc)',
    '![](https://x.com/user/status/123)',
    '![](https://twitter.com/user/status/123)',
    '![](https://www.youtube.com/img/logo.png)',
    '![](https://x.com/logo.png)',
  ].join('\n');
  assert.deepEqual(findRemoteImages(text).map((image) => image.url), [
    'https://www.youtube.com/img/logo.png',
    'https://x.com/logo.png',
  ]);
});
