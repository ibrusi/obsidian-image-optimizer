import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLanguage, stringsFor } from '../src/i18n.ts';
import { RunStats } from '../src/services/stats.ts';
import { normalizeSettings } from '../src/settings.ts';

test('auto follows the Obsidian language, English when the plugin lacks it', () => {
  assert.equal(resolveLanguage('auto', 'ru'), 'ru');
  assert.equal(resolveLanguage('auto', 'en-GB'), 'en');
  assert.equal(resolveLanguage('auto', 'de'), 'en');
  assert.equal(resolveLanguage('auto', 'zh-TW'), 'en');
  assert.equal(resolveLanguage('auto', ''), 'en');
  assert.equal(resolveLanguage('auto', null), 'en');
});

test('a chosen language wins over the Obsidian language', () => {
  assert.equal(resolveLanguage('ru', 'de'), 'ru');
  assert.equal(resolveLanguage('en', 'ru'), 'en');
});

test('the language setting defaults to auto', () => {
  assert.equal(normalizeSettings({}).language, 'auto');
  assert.equal(normalizeSettings({ language: 'ru' }).language, 'ru');
  assert.equal(normalizeSettings({ language: 'de' }).language, 'auto');
});

test('summaries use the plural forms of each language', () => {
  const summary = (language: 'en' | 'ru', converted: number) =>
    stringsFor(language).summary({ converted, kept: 0, failed: 0, before: '', after: '', savings: 0 });
  assert.equal(summary('en', 1), '1 image converted');
  assert.equal(summary('en', 2), '2 images converted');
  assert.equal(summary('ru', 1), 'сжата 1 картинка');
  assert.equal(summary('ru', 3), 'сжаты 3 картинки');
  assert.equal(summary('ru', 5), 'сжато 5 картинок');
  assert.equal(summary('ru', 11), 'сжато 11 картинок');
  assert.equal(summary('ru', 21), 'сжата 21 картинка');
  assert.equal(summary('ru', 0), 'сжато 0 картинок');
});

test('a full summary', () => {
  const s = { converted: 4, kept: 2, failed: 1, before: '2.5 MB', after: '400 KB', savings: 84 };
  assert.equal(stringsFor('en').summary(s), '4 images converted, 2.5 MB → 400 KB (-84%), 2 kept as is, 1 failed');
  assert.equal(stringsFor('ru').summary(s), 'сжаты 4 картинки, 2.5 MB → 400 KB (-84%), 2 оставлены как есть, 1 с ошибкой');
});

test('RunStats computes overall savings percentage for the summary', () => {
  const stats = new RunStats();
  stats.saved('a.png', 1000, 200, 'ok');
  stats.saved('b.png', 1000, 400, 'ok');
  assert.equal(stats.summary(stringsFor('en')), '2 images converted, 2.0 KB → 600 B (-70%)');
  assert.equal(stats.summary(stringsFor('ru')), 'сжаты 2 картинки, 2.0 KB → 600 B (-70%)');
});
