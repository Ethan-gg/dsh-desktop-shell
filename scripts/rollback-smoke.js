'use strict';

/**
 * End-to-end recovery check:
 *   1. boot a clean temporary DSH_HOME and let the shell snapshot it;
 *   2. add a nonexistent bundle to the profile;
 *   3. boot again and prove the shell fails four times, auto-restores the
 *      known-good snapshot, and reaches the UI again.
 *
 * Usage: node scripts/rollback-smoke.js
 * This does not touch the real ~/.dsh or the real profile-snapshots directory.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-rollback-'));
const home = path.join(tmp, 'home');
const profileDir = path.join(home, 'profiles', 'web');
const userData = path.join(tmp, 'userdata');
const workspace = path.join(tmp, 'workspace');
const goodPackage = {
  name: 'dsh-profile-web',
  private: true,
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    },
  },
};

fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(goodPackage, null, 2)}\n`);
fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n');

function run(label, out) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      DSH_HOME: home,
      DSH_DESKTOP_HOME: home,
      DSH_DESKTOP_USER_DATA: userData,
      DSH_DESKTOP_WORKSPACE: workspace,
      DSH_DESKTOP_SMOKE: '1',
      DSH_DESKTOP_SMOKE_OUT: out,
    };
    const child = spawn(electron, ['.', '--smoke-test'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out\n${stdout}\n${stderr}`));
    }, 180_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const first = await run('clean boot', path.join(tmp, 'good.png'));
  if (first.code !== 0 || !first.stdout.includes('SMOKE_OK')) {
    throw new Error(`clean boot failed (${first.code})\n${first.stdout}\n${first.stderr}`);
  }

  const snapshotRoot = path.join(userData, 'profile-snapshots', 'web');
  if (!fs.existsSync(snapshotRoot)) throw new Error('no snapshot was created after the clean boot');
  if (!fs.existsSync(path.join(userData, 'logs', 'desktop.log'))) throw new Error('desktop log missing');

  const brokenPkgDir = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-broken');
  fs.mkdirSync(brokenPkgDir, { recursive: true });
  fs.writeFileSync(path.join(brokenPkgDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-broken',
    version: '0.0.0',
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2));
  fs.writeFileSync(path.join(brokenPkgDir, 'cordis.patch.yml'), '[]\n');

  const broken = {
    ...goodPackage,
    dsh: {
      profile: {
        bundles: [...goodPackage.dsh.profile.bundles, '@deepseek-ai/dsh-broken'],
      },
    },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(broken, null, 2)}\n`);
  // A malformed user patch layer is fatal (unlike an unreadable bundle, which
  // dsh intentionally skips). This is the closest safe analogue to a plugin
  // install that leaves a profile unloadable.
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- id: broken\n  name: [unterminated\n');

  const second = await run('recovery boot', path.join(tmp, 'recovered.png'));
  if (second.code !== 0 || !second.stdout.includes('SMOKE_OK')) {
    throw new Error(`recovery boot failed (${second.code})\n${second.stdout}\n${second.stderr}`);
  }

  const restored = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  const bundles = restored?.dsh?.profile?.bundles ?? [];
  if (bundles.includes('@deepseek-ai/dsh-broken')) {
    throw new Error('broken bundle is still present after recovery');
  }
  const restoredPatch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  if (restoredPatch !== '[]\n') throw new Error(`cordis.patch.yml was not restored: ${JSON.stringify(restoredPatch)}`);
  if (!bundles.includes('@deepseek-ai/dsh-web-app')) throw new Error('known-good web bundle was not restored');

  const log = fs.readFileSync(path.join(userData, 'logs', 'desktop.log'), 'utf8');
  if (!log.includes('回退')) throw new Error('desktop log does not record the rollback');

  console.log(JSON.stringify({
    ok: true,
    temp: tmp,
    snapshotRoot,
    first: { code: first.code, log: first.stdout.match(/SMOKE_OK .*/)?.[0] ?? null },
    second: { code: second.code, log: second.stdout.match(/SMOKE_OK .*/)?.[0] ?? null },
    restoredBundles: bundles,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  console.error(`临时目录保留用于排查：${tmp}`);
  process.exit(1);
});
