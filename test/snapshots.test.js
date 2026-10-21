'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createSnapshot,
  fingerprintProfile,
  latestSnapshot,
  listSnapshots,
  restoreSnapshot,
} = require('../src/profile/snapshots');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-snap-'));
  const dshHome = path.join(root, 'home');
  const profileDir = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name":"web","dsh":{"profile":{"bundles":["core"]}}}\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'bad-plugin'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'bad-plugin', 'index.js'), 'broken\n');
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'sessions', 'keep.jsonl'), 'session\n');
  return { root, dshHome, profileDir, snapshotsRoot: path.join(root, 'snapshots') };
}

test('snapshots only profile configuration, never sessions or node_modules', () => {
  const { dshHome, profileDir, snapshotsRoot } = setup();
  try {
    const snapshot = createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    assert.ok(snapshot);
    assert.deepEqual(snapshot.files.sort(), ['cordis.patch.yml', 'package.json']);
    assert.equal(fs.existsSync(path.join(snapshot.directory, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(snapshot.directory, 'sessions')), false);
    assert.ok(fingerprintProfile(profileDir));
  } finally {
    fs.rmSync(path.dirname(snapshotsRoot), { recursive: true, force: true });
  }
});

test('identical config does not create duplicate snapshots', () => {
  const { dshHome, snapshotsRoot } = setup();
  try {
    const first = createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    const second = createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    assert.equal(first.directory, second.directory);
    assert.equal(listSnapshots(snapshotsRoot, 'web').length, 1);
  } finally {
    fs.rmSync(path.dirname(snapshotsRoot), { recursive: true, force: true });
  }
});

test('restore brings back package.json and removes a newly added managed file', () => {
  const { dshHome, profileDir, snapshotsRoot } = setup();
  try {
    const snapshot = createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name":"web","dsh":{"profile":{"bundles":["core","bad"]}}}\n');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: bad\n');
    fs.writeFileSync(path.join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    restoreSnapshot(snapshot, profileDir);
    assert.match(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), /"core"/);
    assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8').includes('"bad"'), false);
    assert.equal(fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n');
    assert.equal(fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml')), false);
    // Untouched user data remains.
    assert.equal(fs.existsSync(path.join(dshHome, 'sessions', 'keep.jsonl')), true);
  } finally {
    fs.rmSync(path.dirname(snapshotsRoot), { recursive: true, force: true });
  }
});

test('latestSnapshot returns the newest metadata', async () => {
  const { dshHome, profileDir, snapshotsRoot } = setup();
  try {
    createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{"name":"web2"}\n');
    const second = createSnapshot({ root: snapshotsRoot, dshHome, profile: 'web' });
    assert.equal(latestSnapshot(snapshotsRoot, 'web').directory, second.directory);
  } finally {
    fs.rmSync(path.dirname(snapshotsRoot), { recursive: true, force: true });
  }
});
