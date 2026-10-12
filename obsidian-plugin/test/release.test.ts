import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The community catalog reads manifest.json and versions.json from the
// repository root; the build and the release use the plugin's own copy.
const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = json('../manifest.json');
const rootManifest = json('../../manifest.json');
const versions = json('../../versions.json');
const pkg = json('../package.json');

test('the root manifest is the plugin manifest', () => {
  assert.deepEqual(rootManifest, manifest);
  assert.equal(pkg.version, manifest.version);
});

test('versions.json maps the current version to its minimum Obsidian version', () => {
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test('the manifest follows the catalog rules', () => {
  assert.match(manifest.id, /^[a-z0-9-]+$/);
  assert.doesNotMatch(manifest.id, /obsidian/i, 'the id must not contain "obsidian"');
  assert.doesNotMatch(manifest.name, /obsidian/i);
  assert.doesNotMatch(manifest.description, /obsidian/i);
  assert.ok(manifest.description.length <= 250);
  assert.ok(manifest.description.endsWith('.'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
});
