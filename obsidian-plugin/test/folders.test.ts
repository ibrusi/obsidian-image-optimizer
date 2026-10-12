import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInFolder, joinPath, normalizeFolder, resolveFolder, validateFolder } from '../src/domain/folders.ts';

test('normalizeFolder', () => {
  assert.equal(normalizeFolder(' Attachments/ '), 'Attachments');
  assert.equal(normalizeFolder('\\\\a\\\\b//c/'), '/a/b/c');
  assert.equal(normalizeFolder('/'), '/');
  assert.equal(normalizeFolder(''), '');
});

test('validateFolder', () => {
  for (const ok of ['', '/', 'Attachments', '/Attachments/webp', 'Вложения/картинки']) {
    assert.equal(validateFolder(ok), null, ok);
  }
  for (const bad of ['../outside', 'a/./b', '.assets', 'a/.hidden', 'a#b', 'x|y']) {
    assert.notEqual(validateFolder(bad), null, bad);
  }
});

test('resolveFolder', () => {
  const cases: Array<[string, string, string]> = [
    ['Attachments', 'habr', 'habr/Attachments'],
    ['Attachments', '/', 'Attachments'],
    ['/Attachments/webp', 'habr/deep', 'Attachments/webp'],
    ['', 'habr', 'habr'],
    ['', '/', ''],
    ['/', 'habr', ''],
  ];
  for (const [setting, noteDir, want] of cases) {
    assert.equal(resolveFolder(setting, noteDir), want, `${setting} @ ${noteDir}`);
  }
});

test('joinPath', () => {
  assert.equal(joinPath('', 'a.webp'), 'a.webp');
  assert.equal(joinPath('x/y', 'a.webp'), 'x/y/a.webp');
});

test('isInFolder', () => {
  assert.equal(isInFolder('note.md', '/'), true);
  assert.equal(isInFolder('a/b/note.md', ''), true);
  assert.equal(isInFolder('a/note.md', 'a'), true);
  assert.equal(isInFolder('a/b/note.md', 'a'), true, 'subfolders are included');
  assert.equal(isInFolder('ab/note.md', 'a'), false, 'a sibling with the same prefix is not');
  assert.equal(isInFolder('a.md', 'a'), false);
  assert.equal(isInFolder('note.md', 'a'), false);
});
