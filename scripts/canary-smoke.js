'use strict';

/**
 * Proves that a manifest-only canary profile can boot the real dsh Web app,
 * then promotes it and removes the temporary profile. It uses an isolated
 * DSH_HOME, so the real ~/.dsh and its node_modules are untouched.
 *
 * Usage: node scripts/canary-smoke.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DshBackend } = require('../src/backend/dsh-backend');
const { Logger } = require('../src/logger');
const { canaryName, createCanaryProfile, promoteCanaryProfile, removeCanaryProfile } = require('../src/profile/canary');

const root = path.resolve(__dirname, '..');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-canary-smoke-'));
  const dshHome = path.join(tmp, 'home');
  const userDataDir = path.join(tmp, 'userdata');
  const workspace = path.join(tmp, 'workspace');
  const active = path.join(dshHome, 'profiles', 'web');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(active, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2));
  fs.writeFileSync(path.join(active, 'cordis.patch.yml'), '[]\n');

  const logger = new Logger(path.join(userDataDir, 'logs'));
  const canary = createCanaryProfile({ dshHome, profile: 'web' });
  const config = {
    profile: canaryName('web'),
    dshHome,
    workspace,
    userDataDir,
    startupTimeoutMs: 60_000,
    extraArgs: [],
    env: {},
  };

  let info;
  const backend = new DshBackend({ config, logger, appPath: root });
  try {
    info = await backend.start();
    if (!info.url) throw new Error('canary did not produce an authenticated URL');
  } finally {
    await backend.stop().catch(() => {});
  }

  fs.writeFileSync(path.join(canary.directory, 'cordis.patch.yml'), '- id: canary-marker\n  disabled: true\n');
  promoteCanaryProfile({ dshHome, profile: 'web' });
  if (!fs.readFileSync(path.join(active, 'cordis.patch.yml'), 'utf8').includes('canary-marker')) {
    throw new Error('promote did not copy the canary marker');
  }
  removeCanaryProfile({ dshHome, profile: 'web' });

  console.log(JSON.stringify({
    ok: true,
    temp: tmp,
    canary: canary.canary,
    port: info.port,
    activePromoted: true,
    canaryRemoved: !fs.existsSync(canary.directory),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
