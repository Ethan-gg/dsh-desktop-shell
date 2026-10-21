'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveLaunch } = require('./locator');
const { killTree } = require('./dsh-backend');
const { redact } = require('./url');

class PluginCommandError extends Error {
  constructor(message, { code = null, output = '', logPath = null } = {}) {
    super(message);
    this.name = 'PluginCommandError';
    this.code = code;
    this.output = output;
    this.logPath = logPath;
  }
}

/**
 * A package spec is passed as one argv element to `dsh plugin add`, never to a
 * shell. Rejecting a leading dash prevents a user-supplied value from being
 * parsed as a pnpm/dsh option; control characters and a length bound keep logs
 * and argv sane.
 */
function validatePackageSpec(input) {
  const spec = String(input ?? '').trim();
  if (!spec) throw new Error('请输入插件包名或安装地址。');
  if (spec.length > 500) throw new Error('插件安装地址过长（最多 500 字符）。');
  if (spec.startsWith('-')) throw new Error('插件安装地址不能以 “-” 开头。');
  if (/[\u0000-\u001f\u007f]/u.test(spec)) throw new Error('插件安装地址不能包含控制字符。');
  return spec;
}

function sanitize(text) {
  return redact(text);
}

/**
 * Run `dsh plugin --profile <profile> add <spec>` as a direct Node child.
 * This is the official CLI path, so bundle activation, pnpm's lockfile, build
 * approvals, and compatibility checks behave exactly as in a terminal.
 */
async function runDshPlugin({ config, appPath, args, timeoutMs = 5 * 60_000, onOutput, onSpawn }) {
  const launch = await resolveLaunch({ appPath, config });
  const logDir = path.join(config.userDataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const logPath = path.join(logDir, `plugin-${stamp}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  log.on('error', () => {});
  const recent = [];
  let settled = false;

  const env = {
    ...process.env,
    ...config.env,
    DSH_HOME: config.dshHome,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...launch.envExtra,
  };
  if (launch.nodeKind !== 'electron-node') delete env.ELECTRON_RUN_AS_NODE;

  const argv = [...launch.argsPrefix, 'plugin', '--profile', config.profile, ...args];
  log.write(`${new Date().toISOString()} [desktop] launch: ${launch.command} ${redact(argv.join(' '))}\n`);

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, argv, {
        cwd: config.workspace,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      log.end();
      reject(new PluginCommandError(`无法启动 dsh plugin：${error.message}`, { logPath }));
      return;
    }

    const lines = (chunk, stream) => {
      const text = sanitize(chunk);
      log.write(`${new Date().toISOString()} [${stream}] ${text}`);
      for (const line of text.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        recent.push(line);
        if (recent.length > 40) recent.shift();
        try {
          onOutput?.(line, stream);
        } catch {
          // A UI/progress callback must not break the install.
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => lines(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => lines(chunk, 'stderr'));
    onSpawn?.(child);

    const tail = () => recent.slice(-20).join('\n') || '（没有输出）';
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.end();
      fn(value);
    };

    const timer = setTimeout(() => {
      log.write(`${new Date().toISOString()} [desktop] timeout after ${timeoutMs}ms\n`);
      void killTree(child.pid);
      finish(reject, new PluginCommandError(
        `插件安装命令超过 ${Math.round(timeoutMs / 1000)} 秒，已终止。\n${tail()}`,
        { output: tail(), logPath }
      ));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      finish(reject, new PluginCommandError(`插件安装进程启动失败：${error.message}`, { logPath }));
    });
    child.once('exit', (code, signal) => {
      const output = tail();
      if (code === 0) {
        finish(resolve, { code, output, logPath, command: `${launch.command} ${argv.join(' ')}` });
        return;
      }
      finish(reject, new PluginCommandError(
        `插件安装命令失败（code=${code ?? 'null'}, signal=${signal ?? 'null'}）。\n${output}`,
        { code, output, logPath }
      ));
    });
  });
}

module.exports = {
  PluginCommandError,
  runDshPlugin,
  validatePackageSpec,
};
