'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  coerceDshCandidate,
  deriveShimTarget,
  resolveLaunch,
} = require('../src/backend/locator');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-locator-'));
  const binDir = path.join(root, 'node_modules', '.bin');
  const packageDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@echo off\n');
  fs.writeFileSync(path.join(packageDir, 'bin.js'), '// dummy\n');
  return { root, binDir, packageDir };
}

test('derives lib/bin.js from an npm .cmd shim', () => {
  const { root, binDir, packageDir } = setup();
  try {
    assert.equal(deriveShimTarget(path.join(binDir, 'dsh.cmd')), path.join(packageDir, 'bin.js'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coerces .cmd and .js candidates into a bin.js launch target', () => {
  const { root, binDir, packageDir } = setup();
  try {
    assert.equal(coerceDshCandidate(path.join(binDir, 'dsh.cmd')).binJs, path.join(packageDir, 'bin.js'));
    assert.equal(coerceDshCandidate(path.join(packageDir, 'bin.js')).binJs, path.join(packageDir, 'bin.js'));
    assert.equal(coerceDshCandidate(path.join(binDir, 'missing.cmd')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveLaunch uses the real node executable and never the shim', async () => {
  const { root, binDir, packageDir } = setup();
  try {
    const launch = await resolveLaunch({
      appPath: root,
      config: {
        dshBin: path.join(binDir, 'dsh.cmd'),
        nodePath: process.execPath,
      },
    });
    assert.equal(launch.kind, 'node');
    assert.equal(launch.command, process.execPath);
    assert.deepEqual(launch.argsPrefix, [path.join(packageDir, 'bin.js')]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
