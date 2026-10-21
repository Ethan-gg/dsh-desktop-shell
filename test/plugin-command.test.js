'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePackageSpec } = require('../src/backend/plugin-command');

test('accepts registry, scoped, git, path, and tarball specs', () => {
  for (const spec of [
    'some-plugin',
    '@scope/plugin@1.2.3',
    'github:user/repo#v1',
    'D:\\plugins\\local-plugin',
    'https://example.com/plugin.tgz',
  ]) {
    assert.equal(validatePackageSpec(spec), spec);
  }
});

test('rejects empty, option-like, and control-character specs', () => {
  assert.throws(() => validatePackageSpec(''), /请输入/);
  assert.throws(() => validatePackageSpec('--registry=https://evil'), /不能以/);
  assert.throws(() => validatePackageSpec('bad\nname'), /控制字符/);
  assert.throws(() => validatePackageSpec('x'.repeat(501)), /过长/);
});
