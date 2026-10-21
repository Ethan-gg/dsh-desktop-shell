'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, normalize } = require('../src/config');

test('rejects invalid and reserved profile names', () => {
  assert.throws(() => normalize({ profile: '../bad' }, { defaultWorkspace: os.tmpdir() }), /profile 名称不合法/);
  assert.throws(() => normalize({ profile: 'desktop' }, { defaultWorkspace: os.tmpdir() }), /desktop/);
});

test('environment overrides config and resolves DSH_HOME', () => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-config-'));
  try {
    const config = normalize(
      { profile: 'web', dshHome: '~/custom-dsh', workspace: docs },
      { defaultWorkspace: docs, env: { DSH_DESKTOP_PROFILE: 'canary', DSH_DESKTOP_HOME: docs } }
    );
    assert.equal(config.profile, 'canary');
    assert.equal(config.dshHome, path.resolve(docs));
    assert.equal(config.workspace, path.resolve(docs));
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
  }
});

test('creates a config file on first run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-config-file-'));
  try {
    const { config, created } = loadConfig({
      userDataDir: root,
      defaultWorkspace: root,
      env: { DSH_HOME: path.join(root, 'home') },
    });
    assert.equal(created, true);
    assert.equal(config.profile, 'web');
    assert.equal(config.dshHome, path.join(root, 'home'));
    assert.equal(fs.existsSync(path.join(root, 'desktop-config.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
