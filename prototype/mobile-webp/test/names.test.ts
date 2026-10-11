import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseNameFromUrl } from '../src/names.ts';

test('baseNameFromUrl', () => {
  const cases: Array<[string, string]> = [
    ['https://x.test/img/photo.jpg?w=200', 'photo'],
    ['https://x.test/%D1%84%D0%BE%D1%82%D0%BE.png', 'фото'],
    ['https://x.test/a%20b%5B1%5D.png', 'a b_1_'],
    ['https://x.test/', 'image'],
    ['https://x.test/.hidden.png', 'hidden'],
    ['https://x.test/bad%E0%A4%A.png', 'bad%E0%A4%A'],
    ['https://x.test/' + 'я'.repeat(100) + '.png', 'я'.repeat(60)],
  ];
  for (const [url, want] of cases) {
    assert.equal(baseNameFromUrl(url), want, url);
  }
});
