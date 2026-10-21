'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDshUrl, redact, safeOrigin, stripAnsi } = require('../src/backend/url');

test('parses the authenticated URL dsh actually prints', () => {
  const line = 'dsh web: http://127.0.0.1:19828/?token=FpSsIGWE-qIEF3JvyfnQ60NZmXdcb15Yqa09PUZVPSc';
  assert.equal(
    parseDshUrl(line),
    'http://127.0.0.1:19828/?token=FpSsIGWE-qIEF3JvyfnQ60NZmXdcb15Yqa09PUZVPSc'
  );
});

test('strips ANSI and trailing punctuation', () => {
  const line = '\u001b[32mdsh web: http://127.0.0.1:3080/?token=abc\u001b[0m.';
  assert.equal(parseDshUrl(line), 'http://127.0.0.1:3080/?token=abc');
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});

test('rejects unauthenticated, wildcard, and remote URLs', () => {
  assert.equal(parseDshUrl('dsh web: http://127.0.0.1:3080/'), null);
  assert.equal(parseDshUrl('dsh web: http://0.0.0.0:3080/?token=abc'), null);
  assert.equal(parseDshUrl('dsh web: http://example.com/?token=abc'), null);
  assert.equal(parseDshUrl('dsh web: file:///tmp/x?token=abc'), null);
});

test('accepts localhost and IPv6 loopback', () => {
  assert.equal(parseDshUrl('dsh web: http://localhost:9000/?token=t'), 'http://localhost:9000/?token=t');
  assert.equal(parseDshUrl('dsh web: http://[::1]:9000/?token=t'), 'http://[::1]:9000/?token=t');
});

test('redacts tokens in logs and errors', () => {
  assert.equal(
    redact('see http://127.0.0.1:1/?token=secret&x=1'),
    'see http://127.0.0.1:1/?token=<redacted>&x=1'
  );
  assert.equal(redact('token=abc'), 'token=abc');
  assert.equal(redact('https://user:pass@example.com/x'), 'https://<redacted>@example.com/x');
});

test('safeOrigin only returns valid origins', () => {
  assert.equal(safeOrigin('http://127.0.0.1:3080/?token=x'), 'http://127.0.0.1:3080');
  assert.equal(safeOrigin('not a url'), null);
});
