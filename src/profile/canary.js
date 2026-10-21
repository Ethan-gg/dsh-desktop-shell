'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PROFILE_CONFIG_FILES } = require('../constants');

const CANARY_SUFFIX = '-canary';

function assertProfileName(profile) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(profile)) throw new Error(`profile 名称不合法：${profile}`);
}

function canaryName(profile) {
  assertProfileName(profile);
  return `${profile}${CANARY_SUFFIX}`;
}

function canaryDirectory(dshHome, profile) {
  return path.join(dshHome, 'profiles', canaryName(profile));
}

function copyManagedFiles(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of PROFILE_CONFIG_FILES) {
    const source = path.join(sourceDir, name);
    const target = path.join(targetDir, name);
    if (fs.existsSync(source) && fs.lstatSync(source).isFile()) {
      fs.copyFileSync(source, target);
      continue;
    }
    try {
      if (fs.lstatSync(target).isFile()) fs.rmSync(target, { force: true });
    } catch {
      // Absent.
    }
  }
}

function removeNodeModulesLink(canaryDir) {
  const modules = path.join(canaryDir, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(modules);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    fs.unlinkSync(modules);
  } catch {
    try { fs.rmdirSync(modules); } catch { /* best effort */ }
  }
}

/**
 * Create a profile-level canary from the active profile. Only manifest files
 * are copied; package bytes are resolved through the normal profile/parent
 * lookup (or pnpm's shared store) and are never copied here.
 */
function createCanaryProfile({ dshHome, profile }) {
  const activeDir = path.join(dshHome, 'profiles', profile);
  if (!fs.existsSync(path.join(activeDir, 'package.json'))) {
    throw new Error(`active profile 不存在：${activeDir}`);
  }
  const canaryDir = canaryDirectory(dshHome, profile);
  removeCanaryProfile({ dshHome, profile });
  copyManagedFiles(activeDir, canaryDir);
  return { canary: canaryName(profile), directory: canaryDir, linkedModules: false };
}

function promoteCanaryProfile({ dshHome, profile }) {
  const activeDir = path.join(dshHome, 'profiles', profile);
  const canaryDir = canaryDirectory(dshHome, profile);
  if (!fs.existsSync(path.join(canaryDir, 'package.json'))) {
    throw new Error(`canary profile 不存在：${canaryDir}`);
  }
  copyManagedFiles(canaryDir, activeDir);
  return activeDir;
}

function removeCanaryProfile({ dshHome, profile }) {
  const canaryDir = canaryDirectory(dshHome, profile);
  const resolved = path.resolve(canaryDir);
  const profilesRoot = path.resolve(path.join(dshHome, 'profiles'));
  if (path.dirname(resolved) !== profilesRoot || !path.basename(resolved).endsWith(CANARY_SUFFIX)) {
    throw new Error(`拒绝删除非 canary 目录：${canaryDir}`);
  }
  if (!fs.existsSync(canaryDir)) return false;
  removeNodeModulesLink(canaryDir);
  fs.rmSync(canaryDir, { recursive: true, force: true });
  return true;
}

module.exports = {
  CANARY_SUFFIX,
  canaryDirectory,
  canaryName,
  createCanaryProfile,
  promoteCanaryProfile,
  removeCanaryProfile,
};
