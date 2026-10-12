import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedShare, countColors, LOSSLESS_MAX_COLORS, LOSSY_MIN_COLORS, planForAnimation, planForStill,
} from '../src/domain/compression.ts';

const rgba = (...colors: number[]) => new Uint8Array(new Uint32Array(colors).buffer);

test('countColors counts distinct pixels and stops past the cap', () => {
  assert.equal(countColors(rgba(1, 2, 2, 3, 1), 100), 3);
  assert.equal(countColors(rgba(1, 2, 3, 4, 5, 6), 2), 3);
  assert.equal(countColors(new Uint8Array(0), 10), 0);
});

test('changedShare averages the changed pixels between frames', () => {
  assert.equal(changedShare([rgba(1, 2, 3, 4)]), 0);
  assert.equal(changedShare([rgba(1, 2, 3, 4), rgba(1, 2, 3, 4)]), 0);
  assert.equal(changedShare([rgba(1, 2, 3, 4), rgba(9, 2, 3, 4), rgba(9, 9, 9, 4)]), 3 / 8);
});

test('still images: few colours lossless first, many lossy first, in between both', () => {
  assert.deepEqual(planForStill(LOSSLESS_MAX_COLORS), { candidates: ['lossless', 'lossy'], stopAtFirstWorthy: true });
  assert.deepEqual(planForStill(LOSSY_MIN_COLORS), { candidates: ['lossy', 'lossless'], stopAtFirstWorthy: true });
  assert.deepEqual(planForStill(LOSSLESS_MAX_COLORS + 1), { candidates: ['lossless', 'lossy'], stopAtFirstWorthy: false });
});

// Measured: terminal recording 21 colours, 1.8% change (lossless 4× smaller);
// video clip 255 colours, 84% change (lossy 11× smaller); test pattern 217
// colours, 11% change (lossy 25% smaller); scrolled text 250 colours, 24%
// change (lossless 15% smaller).
test('animations: recordings lossless first, video lossy first, in between both', () => {
  assert.equal(planForAnimation(21, 0.018).candidates[0], 'lossless');
  assert.equal(planForAnimation(21, 0.018).stopAtFirstWorthy, true);
  assert.equal(planForAnimation(2, 0.16).candidates[0], 'lossless', 'flat colours');
  assert.deepEqual(planForAnimation(255, 0.84), { candidates: ['lossy', 'lossless'], stopAtFirstWorthy: true });
  assert.equal(planForAnimation(217, 0.11).stopAtFirstWorthy, false);
  assert.equal(planForAnimation(250, 0.24).stopAtFirstWorthy, false);
});
