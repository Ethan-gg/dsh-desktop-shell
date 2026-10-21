'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PROFILE_CONFIG_FILES } = require('../constants');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function profileDirectory(dshHome, profile) {
  return path.join(dshHome, 'profiles', profile);
}

function snapshotDirectory(root, profile) {
  return path.join(root, profile);
}

/**
 * Fingerprint only the configuration files that decide which bundles load.
 * Session stores, credentials, caches, logs, and node_modules are intentionally
 * absent: they are shared with every profile generation and must never be
 * copied or rolled back by this shell.
 */
function fingerprintProfile(profileDir) {
  const hash = crypto.createHash('sha256');
  let found = false;
  for (const name of PROFILE_CONFIG_FILES) {
    const file = path.join(profileDir, name);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    found = true;
    hash.update(name);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return found ? hash.digest('hex') : null;
}

function readMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!meta || typeof meta !== 'object' || typeof meta.createdAt !== 'string' || typeof meta.hash !== 'string') {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

function listSnapshots(root, profile) {
  const dir = snapshotDirectory(root, profile);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const meta = readMeta(full);
      return meta ? { ...meta, directory: full } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function latestSnapshot(root, profile) {
  return listSnapshots(root, profile)[0] ?? null;
}

function writeMetaAtomic(dir, meta) {
  const file = path.join(dir, 'meta.json');
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function pruneSnapshots(root, profile, keep = 8) {
  const snapshots = listSnapshots(root, profile);
  for (const snapshot of snapshots.slice(keep)) {
    try {
      fs.rmSync(snapshot.directory, { recursive: true, force: true });
    } catch {
      // A locked old snapshot is not worth failing startup over.
    }
  }
}

/**
 * Save the current profile configuration after it has been proven bootable.
 * Returns the latest snapshot when the content hash is unchanged, so repeated
 * starts do not create an unbounded pile of identical directories.
 */
function createSnapshot({ root, dshHome, profile, reason = 'ready', force = false, keep = 8 }) {
  const profileDir = profileDirectory(dshHome, profile);
  const hash = fingerprintProfile(profileDir);
  if (!hash) return null;

  const existing = latestSnapshot(root, profile);
  if (!force && existing?.hash === hash) return existing;

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dirName = `${stamp}-${hash.slice(0, 8)}`;
  const dir = path.join(snapshotDirectory(root, profile), dirName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const files = [];
  for (const name of PROFILE_CONFIG_FILES) {
    const source = path.join(profileDir, name);
    try {
      if (!fs.lstatSync(source).isFile()) continue;
    } catch {
      continue;
    }
    const target = path.join(dir, name);
    fs.copyFileSync(source, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Windows mode bits are advisory.
    }
    files.push(name);
  }

  const meta = {
    profile,
    hash,
    createdAt: new Date().toISOString(),
    reason,
    files,
    source: profileDir,
  };
  writeMetaAtomic(dir, meta);
  pruneSnapshots(root, profile, keep);
  return { ...meta, directory: dir };
}

function restoreSnapshot(snapshot, profileDir) {
  if (!snapshot?.directory || !fs.existsSync(snapshot.directory)) {
    throw new Error('快照目录不存在');
  }
  const meta = readMeta(snapshot.directory);
  if (!meta) throw new Error('快照元数据损坏，拒绝恢复');

  fs.mkdirSync(profileDir, { recursive: true });
  for (const name of PROFILE_CONFIG_FILES) {
    const source = path.join(snapshot.directory, name);
    const target = path.join(profileDir, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      continue;
    }
    // A file that did not exist in the known-good snapshot must not linger.
    try {
      if (fs.lstatSync(target).isFile()) fs.rmSync(target, { force: true });
    } catch {
      // Already absent.
    }
  }
  return meta;
}

module.exports = {
  createSnapshot,
  fingerprintProfile,
  latestSnapshot,
  listSnapshots,
  profileDirectory,
  readMeta,
  restoreSnapshot,
  sha256,
};
