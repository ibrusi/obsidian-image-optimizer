import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableName, baseNameFromUrl, pastedImageStem } from '../src/domain/names.ts';

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

test('availableName skips taken names case-insensitively', () => {
  assert.equal(availableName(new Set(), 'pic', 'webp'), 'pic.webp');
  assert.equal(availableName(new Set(['pic.webp', 'pic-1.webp']), 'Pic', 'webp'), 'Pic-2.webp');
});

test('pastedImageStem keeps real names and stamps generic ones', () => {
  const now = new Date(2026, 9, 11, 15, 30, 5);
  assert.equal(pastedImageStem('Снимок экрана.png', now), 'Снимок экрана');
  assert.equal(pastedImageStem('image.png', now), 'Pasted image 20261011153005');
  assert.equal(pastedImageStem('', now), 'Pasted image 20261011153005');
  assert.equal(pastedImageStem('a:b|c.jpg', now), 'a_b_c');
});
