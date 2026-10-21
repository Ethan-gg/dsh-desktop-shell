'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateDshVersion, parseDshVersion } = require('../src/backend/version');

test('parses bare and prefixed dsh versions', () => {
  assert.deepEqual(parseDshVersion('0.2.1-rc.2\n'), {
    raw: '0.2.1-rc.2',
    major: 0,
    minor: 2,
    patch: 1,
    prerelease: 'rc.2',
  });
  assert.equal(parseDshVersion('dsh 0.3.0').raw, '0.3.0');
  assert.equal(parseDshVersion('not a version'), null);
});

test('classifies the tested 0.2 line and warns outside it', () => {
  assert.equal(evaluateDshVersion(parseDshVersion('0.2.1-rc.2')).status, 'supported');
  assert.equal(evaluateDshVersion(parseDshVersion('0.1.9')).status, 'too-old');
  assert.equal(evaluateDshVersion(parseDshVersion('0.3.0')).status, 'untested');
  assert.equal(evaluateDshVersion(null).status, 'unknown');
});
