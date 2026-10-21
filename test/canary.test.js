'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canaryDirectory,
  createCanaryProfile,
  promoteCanaryProfile,
  removeCanaryProfile,
} = require('../src/profile/canary');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-canary-'));
  const dshHome = path.join(root, 'home');
  const active = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(path.join(active, 'package.json'), '{"name":"web","dsh":{"profile":{"bundles":["core"]}}}\n');
  fs.writeFileSync(path.join(active, 'cordis.patch.yml'), '[]\n');
  return { root, dshHome, active };
}

test('creates a manifest-only canary and promotes it', () => {
  const { root, dshHome, active } = setup();
  try {
    const canary = createCanaryProfile({ dshHome, profile: 'web' });
    assert.equal(canary.canary, 'web-canary');
    assert.equal(fs.existsSync(path.join(canary.directory, 'package.json')), true);
    fs.writeFileSync(path.join(canary.directory, 'package.json'), '{"name":"web","dsh":{"profile":{"bundles":["core","new"]}}}\n');
    fs.writeFileSync(path.join(canary.directory, 'cordis.patch.yml'), '- id: new\n');
    promoteCanaryProfile({ dshHome, profile: 'web' });
    assert.match(fs.readFileSync(path.join(active, 'package.json'), 'utf8'), /"new"/);
    assert.equal(fs.readFileSync(path.join(active, 'cordis.patch.yml'), 'utf8'), '- id: new\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes a canary without touching the active profile', () => {
  const { root, dshHome, active } = setup();
  try {
    const canary = createCanaryProfile({ dshHome, profile: 'web' });
    removeCanaryProfile({ dshHome, profile: 'web' });
    assert.equal(fs.existsSync(canary.directory), false);
    assert.equal(fs.existsSync(path.join(active, 'package.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removing a missing canary is a no-op', () => {
  const { root, dshHome, active } = setup();
  try {
    assert.equal(removeCanaryProfile({ dshHome, profile: 'web' }), false);
    assert.equal(fs.existsSync(path.join(active, 'package.json')), true);
    assert.equal(fs.existsSync(canaryDirectory(dshHome, 'web')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
