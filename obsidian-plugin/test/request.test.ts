import assert from 'node:assert/strict';
import { test } from 'node:test';
import { originalUrlsFor, pageUrlOf, refererFor } from '../src/domain/request.ts';

test('pageUrlOf reads the source page from front matter', () => {
  assert.equal(pageUrlOf('---\ntitle: "X"\nsource: "https://xakep.ru/2015/04/a/"\n---\ntext'), 'https://xakep.ru/2015/04/a/');
  assert.equal(pageUrlOf('---\r\nurl: https://habr.com/p/1\r\n---\r\n'), 'https://habr.com/p/1');
  assert.equal(pageUrlOf('text\nsource: https://x.test/\n'), null, 'only front matter counts');
  assert.equal(pageUrlOf('---\nsource: ftp://x.test/\n---\n'), null);
  assert.equal(pageUrlOf(''), null);
});

test('refererFor prefers the source page of the same site', () => {
  const page = 'https://xakep.ru/2015/04/a/';
  assert.equal(refererFor('https://static.xakep.ru/images/1/2.webp', page), page);
  assert.equal(refererFor('https://cdn.other.test/a.png', page), 'https://cdn.other.test/');
  assert.equal(refererFor('https://x.test:8080/a/b.png', null), 'https://x.test:8080/');
  assert.equal(refererFor('not a url', page), undefined);
});

test('originalUrlsFor lists originals of a .webp', () => {
  assert.deepEqual(originalUrlsFor('https://xakep.ru/up/golcev_proc.webp'), [
    'https://xakep.ru/up/golcev_proc.jpg',
    'https://xakep.ru/up/golcev_proc.jpeg',
    'https://xakep.ru/up/golcev_proc.png',
    'https://xakep.ru/up/golcev_proc.gif',
  ]);
  assert.deepEqual(originalUrlsFor('https://x.test/a.JPG.webp?v=2'), ['https://x.test/a.JPG?v=2']);
  assert.deepEqual(originalUrlsFor('https://x.test/v1.2.webp')[0], 'https://x.test/v1.2.jpg', 'a dot in the name is not an extension');
  assert.deepEqual(originalUrlsFor('https://x.test/a.png'), []);
  assert.deepEqual(originalUrlsFor('https://x.test/webp'), []);
  assert.deepEqual(originalUrlsFor('bad'), []);
});
