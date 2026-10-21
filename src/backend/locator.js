'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DSH_PACKAGE = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');

function existsFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * npm/pnpm install a POSIX shell shim and a .cmd shim next to the package.
 * We do not execute the shim: spawning it would add cmd.exe to the process
 * tree and make shutdown/tree-kill unreliable. Instead, derive the real
 * bin.js path from `<prefix>/node_modules/.bin/dsh.cmd`.
 */
function deriveShimTarget(shimPath) {
  const binDir = path.dirname(shimPath);
  return path.resolve(binDir, '..', DSH_PACKAGE);
}

async function whereAll(name, env = process.env) {
  const isWindows = process.platform === 'win32';
  try {
    const { stdout } = await execFileAsync(isWindows ? 'where.exe' : 'which', [name], {
      env,
      windowsHide: true,
      timeout: 5_000,
      encoding: 'utf8',
    });
    return stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveNode({ config = {}, env = process.env } = {}) {
  const configured = config.nodePath || env.DSH_DESKTOP_NODE || env.DSH_NODE || env.npm_node_execpath;
  if (configured && existsFile(configured)) return { path: configured, kind: 'node', source: 'config' };

  const found = await whereAll('node', env);
  for (const candidate of found) {
    if (existsFile(candidate)) return { path: candidate, kind: 'node', source: 'PATH' };
  }

  if (process.versions.electron) {
    return { path: process.execPath, kind: 'electron-node', source: 'electron' };
  }
  return { path: 'node', kind: 'node', source: 'fallback' };
}

function coerceDshCandidate(candidate) {
  if (!candidate) return null;
  const absolute = path.resolve(candidate);
  if (!existsFile(absolute)) return null;
  const ext = path.extname(absolute).toLowerCase();

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { binJs: absolute, source: absolute };
  }
  if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
    const binJs = deriveShimTarget(absolute);
    if (existsFile(binJs)) return { binJs, source: absolute };
  }
  return null;
}

async function findDsh({ appPath, config = {}, env = process.env } = {}) {
  const explicit = [
    config.dshBin,
    env.DSH_DESKTOP_DSH,
    env.DSH_BIN,
  ].filter(Boolean);

  for (const candidate of explicit) {
    const resolved = coerceDshCandidate(candidate);
    if (resolved) return resolved;
    throw new Error(`配置的 dshBin 不可用：${candidate}\n它应当指向 @deepseek-ai/dsh 的 lib/bin.js，或 npm 生成的 dsh.cmd。`);
  }

  // A bundled dependency is the most reproducible layout.
  const localPackage = path.join(appPath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (existsFile(localPackage)) return { binJs: localPackage, source: 'app dependency' };

  const pathCandidates = await whereAll('dsh', env);
  // Prefer .cmd/.js over .ps1, and never execute a shim.
  pathCandidates.sort((a, b) => {
    const score = (value) => (value.toLowerCase().endsWith('.cmd') ? 0 : value.toLowerCase().endsWith('.js') ? 1 : 2);
    return score(a) - score(b);
  });
  for (const candidate of pathCandidates) {
    const resolved = coerceDshCandidate(candidate);
    if (resolved) return resolved;
  }

  throw new Error(
    '未找到 dsh。请先安装 DeepSeek Harness（例如 `npm i -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh --version`），' +
    '然后在 desktop-config.json 中把 dshBin 指向 dsh 的 lib/bin.js。'
  );
}

/**
 * Resolve a spawnable command. dsh itself always runs under a real Node
 * process; if only Electron's Node is available we use it with
 * ELECTRON_RUN_AS_NODE=1.
 */
async function resolveLaunch({ appPath, config = {}, env = process.env } = {}) {
  const dsh = await findDsh({ appPath, config, env });
  const node = await resolveNode({ config, env });
  const envExtra = node.kind === 'electron-node' ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return {
    kind: 'node',
    command: node.path,
    nodeKind: node.kind,
    nodeSource: node.source,
    argsPrefix: [dsh.binJs],
    dshSource: dsh.source,
    envExtra,
  };
}

module.exports = {
  DSH_PACKAGE,
  coerceDshCandidate,
  deriveShimTarget,
  findDsh,
  resolveLaunch,
  resolveNode,
  whereAll,
};
