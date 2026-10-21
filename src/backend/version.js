'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveLaunch } = require('./locator');

const execFileAsync = promisify(execFile);
const VERSION_RE = /(?:^|[^\d])(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u;

/**
 * Parse a dsh version from `dsh --version` output. The CLI prints a bare
 * semver today, but accepting a prefix keeps this compatible with a future
 * "dsh x.y.z" line.
 */
function parseDshVersion(output) {
  const match = String(output).match(VERSION_RE);
  if (!match) return null;
  return {
    raw: match[0].replace(/^[^\d]+/u, ''),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/**
 * The URL line is the one private contract this shell relies on. A version
 * outside the tested minor line is not refused — dsh may still work — but the
 * user gets an explicit warning and a useful timeout message instead of a
 * silent 60-second wait.
 */
function evaluateDshVersion(version) {
  if (!version) {
    return {
      status: 'unknown',
      message: '无法读取 dsh 版本；仍会尝试启动，但如果 URL 行格式变化，启动会明确失败而不是静默等待。',
    };
  }
  if (version.major === 0 && version.minor === 2) {
    return { status: 'supported', message: `已验证 ${version.raw} 的 URL 行格式。` };
  }
  if (version.major === 0 && version.minor < 2) {
    return {
      status: 'too-old',
      message: `dsh ${version.raw} 早于本壳验证过的 0.2.x；请升级 dsh，否则可能无法识别启动 URL。`,
    };
  }
  return {
    status: 'untested',
    message: `dsh ${version.raw} 超出本壳重点验证的 0.2.x 范围；启动时会校验认证 URL 行，格式变化会给出明确错误。`,
  };
}

async function checkDshVersion({ config, appPath, timeoutMs = 15_000 } = {}) {
  const launch = await resolveLaunch({ appPath, config });
  const env = {
    ...process.env,
    ...config.env,
    DSH_HOME: config.dshHome,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    ...launch.envExtra,
  };
  if (launch.nodeKind !== 'electron-node') delete env.ELECTRON_RUN_AS_NODE;

  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(launch.command, [...launch.argsPrefix, '--version'], {
      cwd: config.workspace,
      env,
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    // A non-zero exit is still useful if the version was printed; keep the
    // output and let the caller report the failure.
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
    if (!stdout && !stderr) throw new Error(`dsh --version 执行失败：${error.message}`);
  }
  const version = parseDshVersion(stdout) ?? parseDshVersion(stderr);
  return {
    ...evaluateDshVersion(version),
    version,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    command: launch.command,
    argsPrefix: launch.argsPrefix,
  };
}

module.exports = { checkDshVersion, evaluateDshVersion, parseDshVersion };
