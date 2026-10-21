'use strict';

const APP_NAME = 'dsh Desktop';
const APP_ID = 'com.deepseek.dsh.desktop-shell';
const APP_DIR_NAME = 'dsh-desktop';

/**
 * Files that belong to a dsh profile's *configuration*, as opposed to its
 * sessions, credentials, caches, logs, and installed package bytes.
 *
 * Snapshots deliberately stay this small:
 * - copying the whole DSH_HOME duplicates sessions and credentials;
 * - node_modules can be hundreds of MB and is not needed to disable a plugin;
 * - package.json is what selects bundles, so restoring it is enough to stop a
 *   broken plugin from being loaded.
 */
const PROFILE_CONFIG_FILES = Object.freeze([
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
]);

const DEFAULT_PROFILE = 'web';
const DEFAULT_HOST = '127.0.0.1';
const TOKEN_QUERY = 'token';

module.exports = {
  APP_NAME,
  APP_ID,
  APP_DIR_NAME,
  PROFILE_CONFIG_FILES,
  DEFAULT_PROFILE,
  DEFAULT_HOST,
  TOKEN_QUERY,
};
