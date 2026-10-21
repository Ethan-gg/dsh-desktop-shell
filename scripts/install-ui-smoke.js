'use strict';

/**
 * End-to-end safe-install smoke:
 *   launch the real Electron shell with an isolated DSH_HOME,
 *   fill/submit the local install dialog automatically, and assert that the
 *   canary install promoted a local bundle into the active profile.
 *
 * Usage: node scripts/install-ui-smoke.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packaged = process.env.DSH_DESKTOP_ELECTRON;
const electron = packaged || path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronArgs = packaged ? ['--smoke-test'] : ['.', '--smoke-test'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-install-ui-'));
const dshHome = path.join(tmp, 'home');
const userData = path.join(tmp, 'userdata');
const workspace = path.join(tmp, 'workspace');
const active = path.join(dshHome, 'profiles', 'web');
const pluginDir = path.join(tmp, 'demo-plugin');
const out = path.join(tmp, 'installed.png');
const packageName = 'dsh-desktop-demo-plugin';

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
  name: packageName,
  version: '1.0.0',
  type: 'module',
  description: 'local bundle for dsh Desktop install UI smoke',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2));
fs.writeFileSync(path.join(pluginDir, 'cordis.patch.yml'), '[]\n');

const env = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_DESKTOP_HOME: dshHome,
  DSH_DESKTOP_USER_DATA: userData,
  DSH_DESKTOP_WORKSPACE: workspace,
  DSH_DESKTOP_SMOKE: '1',
  DSH_DESKTOP_SMOKE_INSTALL: '1',
  DSH_DESKTOP_SMOKE_INSTALL_SPEC: pluginDir,
  DSH_DESKTOP_SMOKE_INSTALL_PACKAGE: packageName,
  DSH_DESKTOP_SMOKE_OUT: out,
};

const child = spawn(electron, electronArgs, {
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
  console.error('install UI smoke timed out');
  console.error(stdout);
  console.error(stderr);
  process.exit(1);
}, 240_000);

child.once('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0 || !stdout.includes('SMOKE_OK')) {
    console.error(`install UI smoke failed (code=${code})`);
    console.error(stdout);
    console.error(stderr);
    process.exit(1);
  }
  const line = stdout.split(/\r?\n/u).find((item) => item.startsWith('SMOKE_OK '));
  const status = JSON.parse(line.slice('SMOKE_OK '.length));
  const manifest = JSON.parse(fs.readFileSync(path.join(active, 'package.json'), 'utf8'));
  if (!manifest.dependencies?.[packageName]) {
    console.error('active profile did not receive the installed dependency');
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    temp: tmp,
    install: status.install,
    dependency: manifest.dependencies[packageName],
    bundleActive: (manifest.dsh?.profile?.bundles ?? []).includes(packageName),
  }, null, 2));
});
