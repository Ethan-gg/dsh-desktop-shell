'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_PROFILE } = require('./constants');

const CONFIG_FILE = 'desktop-config.json';
const PROFILE_RE = /^[a-z0-9][a-z0-9._-]*$/;

const DEFAULTS = Object.freeze({
  profile: DEFAULT_PROFILE,
  dshHome: null,
  workspace: null,
  dshBin: null,
  nodePath: null,
  startupTimeoutMs: 60_000,
  extraArgs: [],
  env: {},
  startHidden: false,
});

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveUserPath(value) {
  return path.resolve(expandHome(String(value)));
}

function defaultDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return path.resolve(expandHome(configured || path.join(os.homedir(), '.dsh')));
}

function asString(value, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function normalize(raw, { defaultWorkspace, env = process.env } = {}) {
  const config = { ...DEFAULTS, ...raw };

  if (env.DSH_DESKTOP_PROFILE) config.profile = env.DSH_DESKTOP_PROFILE;
  if (env.DSH_DESKTOP_HOME) config.dshHome = env.DSH_DESKTOP_HOME;
  if (env.DSH_DESKTOP_WORKSPACE) config.workspace = env.DSH_DESKTOP_WORKSPACE;
  if (env.DSH_DESKTOP_DSH) config.dshBin = env.DSH_DESKTOP_DSH;
  if (env.DSH_DESKTOP_NODE) config.nodePath = env.DSH_DESKTOP_NODE;

  config.profile = String(config.profile || DEFAULT_PROFILE).trim();
  if (!PROFILE_RE.test(config.profile)) {
    throw new Error(`profile 名称不合法：${JSON.stringify(config.profile)}（只允许小写字母、数字、点、下划线和短横线）`);
  }
  if (config.profile === 'desktop') {
    throw new Error('profile "desktop" 是 dsh 官方 Electron 保留名称，不能由外部壳启动；请使用 web 或自定义 profile。');
  }

  const configuredHome = asString(config.dshHome, 'dshHome');
  config.dshHome = resolveUserPath(configuredHome || defaultDshHome(env));

  const configuredWorkspace = asString(config.workspace, 'workspace');
  config.workspace = resolveUserPath(configuredWorkspace || defaultWorkspace || os.homedir());
  try {
    if (!fs.statSync(config.workspace).isDirectory()) config.workspace = os.homedir();
  } catch {
    config.workspace = os.homedir();
  }

  config.dshBin = asString(config.dshBin, 'dshBin');
  if (config.dshBin) config.dshBin = resolveUserPath(config.dshBin);
  config.nodePath = asString(config.nodePath, 'nodePath');
  if (config.nodePath) config.nodePath = resolveUserPath(config.nodePath);

  const timeout = Number(config.startupTimeoutMs);
  if (!Number.isFinite(timeout) || timeout < 5_000 || timeout > 300_000) {
    throw new Error('startupTimeoutMs 必须是 5000 到 300000 之间的数字');
  }
  config.startupTimeoutMs = Math.round(timeout);

  if (!Array.isArray(config.extraArgs) || config.extraArgs.some((item) => typeof item !== 'string')) {
    throw new Error('extraArgs 必须是字符串数组');
  }
  config.extraArgs = [...config.extraArgs];

  if (config.env === null || typeof config.env !== 'object' || Array.isArray(config.env)) {
    throw new Error('env 必须是对象');
  }
  const normalizedEnv = {};
  for (const [key, value] of Object.entries(config.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`env 变量名不合法：${key}`);
    if (value === null) continue;
    normalizedEnv[key] = String(value);
  }
  config.env = normalizedEnv;
  config.startHidden = Boolean(config.startHidden);

  return config;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取配置文件 ${file}：${error.message}`);
  }
}

function loadConfig({ userDataDir, defaultWorkspace, env = process.env } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, CONFIG_FILE);
  const raw = readJson(file);
  const config = normalize(raw || {}, { defaultWorkspace, env });
  if (raw === null) {
    const example = {
      _comment: [
        'dsh Desktop 配置文件。修改后重启应用生效。',
        'dshHome 留空时使用 $DSH_HOME，否则使用 ~/.dsh。',
        'workspace 是 dsh 的默认工作区；留空时使用“文档”目录。',
        'dshBin 可指向 dsh 的 lib/bin.js 或 npm 生成的 dsh.cmd；留空时自动在 PATH 中查找。',
        'nodePath 可指定启动 dsh 的 node.exe；留空时使用 PATH 中的 node。',
      ],
      ...DEFAULTS,
      dshHome: null,
      workspace: config.workspace,
    };
    fs.writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return { config, configPath: file, created: raw === null };
}

module.exports = {
  CONFIG_FILE,
  DEFAULTS,
  PROFILE_RE,
  loadConfig,
  normalize,
  defaultDshHome,
};
