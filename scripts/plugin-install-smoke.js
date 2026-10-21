'use strict';

/**
 * Exercises the canary install mechanics without the UI:
 *   create a temporary DSH_HOME → create a local dsh bundle package →
 *   dsh plugin add into web-canary → boot the canary → promote → remove.
 *
 * Usage: node scripts/plugin-install-smoke.js
 * The real ~/.dsh is not touched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DshBackend } = require('../src/backend/dsh-backend');
const { Logger } = require('../src/logger');
const { runDshPlugin } = require('../src/backend/plugin-command');
const { canaryName, createCanaryProfile, promoteCanaryProfile, removeCanaryProfile } = require('../src/profile/canary');

const root = path.resolve(__dirname, '..');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-plugin-smoke-'));
  const dshHome = path.join(tmp, 'home');
  const userDataDir = path.join(tmp, 'userdata');
  const workspace = path.join(tmp, 'workspace');
  const active = path.join(dshHome, 'profiles', 'web');
  const pluginDir = path.join(tmp, 'demo-plugin');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(path.join(active, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2));
  fs.writeFileSync(path.join(active, 'cordis.patch.yml'), '[]\n');
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-demo-plugin',
    version: '1.0.0',
    type: 'module',
    description: 'local bundle for dsh Desktop install smoke',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '[]\n');

  const canary = createCanaryProfile({ dshHome, profile: 'web' });
  const config = {
    profile: canary.canary,
    dshHome,
    workspace,
    userDataDir,
    startupTimeoutMs: 60_000,
    extraArgs: [],
    env: {},
  };
  const logger = new Logger(path.join(userDataDir, 'logs'));

  await runDshPlugin({
    config,
    appPath: root,
    args: ['add', pluginDir],
    timeoutMs: 180_000,
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(canary.directory, 'package.json'), 'utf8'));
  if (!manifest.dependencies?.['dsh-desktop-demo-plugin']) {
    throw new Error('plugin dependency was not added to the canary manifest');
  }
  if (!(manifest.dsh?.profile?.bundles ?? []).includes('dsh-desktop-demo-plugin')) {
    throw new Error('plugin bundle was not activated in the canary manifest');
  }

  const probe = new DshBackend({ config, logger, appPath: root });
  let info;
  try {
    info = await probe.start();
  } finally {
    await probe.stop().catch(() => {});
  }
  promoteCanaryProfile({ dshHome, profile: 'web' });
  removeCanaryProfile({ dshHome, profile: 'web' });

  console.log(JSON.stringify({
    ok: true,
    temp: tmp,
    canary: canaryName('web'),
    port: info.port,
    dependency: manifest.dependencies['dsh-desktop-demo-plugin'],
    bundleActivated: true,
    canaryRemoved: !fs.existsSync(canary.directory),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
