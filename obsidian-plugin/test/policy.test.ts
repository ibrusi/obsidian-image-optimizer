import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockedHostReason, worthReplacing } from '../src/domain/policy.ts';

test('worthReplacing', () => {
  assert.equal(worthReplacing(1000, 1000, 0), false, 'equal size is never worth it');
  assert.equal(worthReplacing(1000, 999, 0), true);
  assert.equal(worthReplacing(1000, 950, 5), true, 'exactly 5%');
  assert.equal(worthReplacing(1000, 951, 5), false);
  assert.equal(worthReplacing(1000, 1200, 5), false);
});

test('blockedHostReason refuses local and private hosts', () => {
  const blocked = [
    'http://localhost/a.png', 'http://printer.local/a.png', 'http://127.0.0.1/a.png', 'http://2130706433/a.png',
    'http://0x7f.1/a.png', 'http://10.1.2.3/a.png', 'http://172.20.0.1/a.png', 'http://192.168.1.1/a.png',
    'http://169.254.169.254/latest', 'http://100.64.0.1/a.png', 'http://0.0.0.0/', 'http://198.18.0.1/',
    'http://[::1]/a.png', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[64:ff9b::a00:1]/', 'http://[2002:c0a8:101::]/', 'ftp://x.test/a.png', 'file:///etc/passwd',
  ];
  for (const url of blocked) assert.notEqual(blockedHostReason(url, false), null, url);
});

test('blockedHostReason allows public hosts, and private ones when allowed', () => {
  for (const url of ['https://habrastorage.org/a.png', 'http://8.8.8.8/a.png', 'http://[2606:4700::1111]/']) {
    assert.equal(blockedHostReason(url, false), null, url);
  }
  assert.equal(blockedHostReason('http://192.168.1.1/a.png', true), null);
  assert.notEqual(blockedHostReason('file:///etc/passwd', true), null, 'protocol is checked regardless');
});
