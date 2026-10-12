import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings.ts';

test('defaults for missing or broken data', () => {
  for (const raw of [undefined, null, 42, 'x', [], {}]) {
    assert.deepEqual(normalizeSettings(raw), DEFAULT_SETTINGS);
  }
});

test('numbers are clamped and rounded, junk falls back to defaults', () => {
  const s = normalizeSettings({ quality: 500, method: -3, minSavingsPercent: '7.6', maxDownloadMB: 'many', maxMegapixels: Infinity });
  assert.equal(s.quality, 100);
  assert.equal(s.method, 0);
  assert.equal(s.minSavingsPercent, 8);
  assert.equal(s.maxDownloadMB, DEFAULT_SETTINGS.maxDownloadMB);
  assert.equal(s.maxMegapixels, DEFAULT_SETTINGS.maxMegapixels);
});

test('invalid folders fall back, valid ones are normalized', () => {
  assert.equal(normalizeSettings({ folder: '../x' }).folder, DEFAULT_SETTINGS.folder);
  assert.equal(normalizeSettings({ folder: ' /Img/webp/ ' }).folder, '/Img/webp');
});

test('settings of the Go-backed 1.x plugin are migrated where they still apply', () => {
  const s = normalizeSettings({ binaryPath: 'obsidian-img-opt', quality: 55, attachedDir: 'attachments', allowPrivateHosts: true, gifLossy: 80 });
  assert.equal(s.quality, 55);
  assert.equal(s.folder, 'attachments');
  assert.equal(s.allowPrivateHosts, true);
  assert.ok(!('binaryPath' in s));
});

test('reuseIdentical is on by default and can be turned off', () => {
  assert.equal(normalizeSettings({}).reuseIdentical, true);
  assert.equal(normalizeSettings({ reuseIdentical: false }).reuseIdentical, false);
  assert.equal(normalizeSettings({ reuseIdentical: 'no' }).reuseIdentical, true, 'junk falls back to the default');
});
