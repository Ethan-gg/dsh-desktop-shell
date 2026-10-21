'use strict';

const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseDshUrl, redact } = require('./url');
const { waitForDsh } = require('./health');
const { resolveLaunch } = require('./locator');

const IS_WINDOWS = process.platform === 'win32';

class DshStoppedError extends Error {
  constructor() {
    super('dsh 后端已被停止');
    this.name = 'DshStoppedError';
    this.code = 'DSH_STOPPED';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (IS_WINDOWS) {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    resolve();
  });
}

/**
 * Owns exactly one dsh Web child process.
 *
 * Important differences from a naive spawn:
 * - dsh does not accept a bare URL. It prints an authenticated URL with a
 *   per-process token; we capture that line and load it.
 * - `--port 0` makes the OS pick a port, so another dsh on 3080 can never
 *   collide with this instance.
 * - the child is Node + lib/bin.js, not `npx`/cmd.exe, so stopping it does not
 *   leave an orphaned grandchild.
 */
class DshBackend extends EventEmitter {
  constructor({ config, logger, appPath, version = null }) {
    super();
    this.config = config;
    this.logger = logger;
    this.appPath = appPath;
    this.version = version;
    this.child = null;
    this.ready = false;
    this.url = null;
    this.port = null;
    this.startedAt = 0;
    this.logPath = null;
    this.logStream = null;
    this.healthTimer = null;
    this.healthFailures = 0;
    this.recentLines = [];
    this.launch = null;
    this._startPromise = null;
    this._readySettled = false;
    this._resolveReady = null;
    this._rejectReady = null;
    this._startTimer = null;
    this._exited = null;
    this._resolveExited = null;
    this._stopping = false;
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null);
  }

  getStatus() {
    return {
      running: this.running,
      ready: this.ready,
      pid: this.child?.pid ?? null,
      port: this.port,
      startedAt: this.startedAt,
      logPath: this.logPath,
      healthFailures: this.healthFailures,
    };
  }

  async start() {
    if (this._startPromise) throw new Error('dsh 后端已经在启动');
    this._startPromise = this._start();
    try {
      return await this._startPromise;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async _start() {
    this.launch = await resolveLaunch({ appPath: this.appPath, config: this.config });
    this.logPath = this._openLog();
    this._writeLog(`launch: ${this.launch.command} ${this.launch.argsPrefix.join(' ')}`);
    this._writeLog(`node: ${this.launch.nodeKind} (${this.launch.nodeSource}), dsh: ${this.launch.dshSource}`);
    this._writeLog(`cwd: ${this.config.workspace}`);
    this._writeLog(`DSH_HOME: ${this.config.dshHome}, profile: ${this.config.profile}, dsh: ${this.version ?? 'unknown'}`);

    const args = [
      ...this.launch.argsPrefix,
      '--profile', this.config.profile,
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
      ...this.config.extraArgs,
    ];

    const env = {
      ...process.env,
      ...this.config.env,
      DSH_HOME: this.config.dshHome,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      ...this.launch.envExtra,
    };
    if (this.launch.nodeKind !== 'electron-node') {
      delete env.ELECTRON_RUN_AS_NODE;
    }

    this._readySettled = false;
    const ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });

    this._exited = new Promise((resolve) => {
      this._resolveExited = resolve;
    });

    this._startTimer = setTimeout(() => {
      this._failReady(new Error(
        `dsh ${this.version ?? '(版本未知)'} 未在 ${Math.round(this.config.startupTimeoutMs / 1000)} 秒内输出认证 URL。\n` +
        '本壳依赖这一行：dsh web: http://127.0.0.1:<port>/?token=...\n' +
        `如果 dsh 已升级，可能是 URL 行格式变化。\n最近输出：\n${this._tail()}`
      ));
    }, this.config.startupTimeoutMs);
    this._startTimer.unref?.();

    let child;
    try {
      child = spawn(this.launch.command, args, {
        cwd: this.config.workspace,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this._failReady(new Error(`无法启动 dsh：${error.message}`));
      throw error;
    }

    this.child = child;
    this.startedAt = Date.now();
    this._writeLog(`spawned pid ${child.pid ?? '(pending)'}`);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => this._onOutput('stderr', chunk));

    child.once('error', (error) => {
      this._writeLog(`child error: ${error.message}`, 'stderr');
      this._failReady(new Error(`dsh 进程启动失败：${error.message}`));
      this._resolveExited?.();
      this._resolveExited = null;
    });

    child.once('exit', (code, signal) => {
      this._onExit(code, signal);
    });

    let info;
    try {
      info = await ready;
      if (this._stopping) throw new DshStoppedError();
      const healthy = await Promise.race([
        waitForDsh(this.port, {
          timeoutMs: 12_000,
          intervalMs: 250,
          host: '127.0.0.1',
        }),
        this._exited.then(() => false),
      ]);
      if (!healthy) throw new Error(`dsh 已打印地址，但健康检查失败（端口 ${this.port}）。\n${this._tail()}`);
      if (this._stopping) throw new DshStoppedError();
      if (!this.running) throw new Error(`dsh 后端在就绪前退出。\n${this._tail()}`);
    } catch (error) {
      this._failReady(error);
      throw error;
    }

    this.ready = true;
    this.healthFailures = 0;
    this._writeLog(`ready: pid ${info.pid}, port ${this.port}`);
    return { ...info, url: this.url, port: this.port };
  }

  _onOutput(stream, chunk) {
    const key = stream === 'stdout' ? '_stdoutBuffer' : '_stderrBuffer';
    this[key] += chunk;
    const parts = this[key].split(/\r?\n/u);
    this[key] = parts.pop() ?? '';
    for (const line of parts) this._onLine(stream, line);
  }

  _onLine(stream, rawLine) {
    const line = rawLine.replace(/\r$/u, '');
    if (!line) return;

    const cleanForLog = redact(line);
    this._writeLog(cleanForLog, stream);
    this.recentLines.push(cleanForLog);
    if (this.recentLines.length > 40) this.recentLines.shift();

    if (!this.url) {
      const parsed = parseDshUrl(line);
      if (parsed) {
        this.url = parsed;
        const parsedUrl = new URL(parsed);
        this.port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));
        this._writeLog(`authenticated URL received; listening on 127.0.0.1:${this.port}`);
        this._resolveReadyValue({ pid: this.child?.pid ?? null, port: this.port });
      }
    }
  }

  _onExit(code, signal) {
    // Flush a final unterminated line so a crash message is not lost.
    if (this._stdoutBuffer) this._onLine('stdout', this._stdoutBuffer);
    if (this._stderrBuffer) this._onLine('stderr', this._stderrBuffer);
    this._stdoutBuffer = '';
    this._stderrBuffer = '';

    const expected = this._stopping;
    const pid = this.child?.pid ?? null;
    const uptimeMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    this._clearStartTimer();
    this.stopHealthMonitor();
    if (!this._readySettled) {
      this._failReady(new Error(
        `dsh 后端在就绪前退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）。\n${this._tail()}`
      ));
    }
    this.ready = false;
    this.child = null;
    this._writeLog(`exit: code=${code ?? 'null'} signal=${signal ?? 'null'} expected=${expected} uptimeMs=${uptimeMs}`);
    this._closeLog();
    this._resolveExited?.();
    this._resolveExited = null;
    this.emit(expected ? 'stopped' : 'exit', { code, signal, pid, uptimeMs });
  }

  _failReady(error) {
    if (this._readySettled) return;
    this._readySettled = true;
    this._clearStartTimer();
    this._rejectReady?.(error);
  }

  _resolveReadyValue(value) {
    if (this._readySettled) return;
    this._readySettled = true;
    this._clearStartTimer();
    this._resolveReady?.(value);
  }

  _clearStartTimer() {
    if (this._startTimer) {
      clearTimeout(this._startTimer);
      this._startTimer = null;
    }
  }

  _tail() {
    return this.recentLines.slice(-12).join('\n') || '（没有输出）';
  }

  _openLog() {
    if (!this.config.userDataDir) throw new Error('内部错误：缺少 userDataDir');
    const dir = path.join(this.config.userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    // Restart storms can generate many small logs; keep the newest 40.
    try {
      const old = fs.readdirSync(dir)
        .filter((name) => /^backend-.*\.log$/u.test(name))
        .sort();
      for (const name of old.slice(0, Math.max(0, old.length - 39))) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      // Log retention is best-effort.
    }
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const file = path.join(dir, `backend-${stamp}.log`);
    this.logStream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
    this.logStream.on('error', () => {});
    return file;
  }

  _writeLog(line, stream = 'desktop') {
    if (!this.logStream) return;
    const clean = redact(line);
    this.logStream.write(`${new Date().toISOString()} [${stream}] ${clean}\n`);
  }

  _closeLog() {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }

  startHealthMonitor(onUnhealthy) {
    this.stopHealthMonitor();
    this.healthFailures = 0;
    this.healthTimer = setInterval(async () => {
      if (!this.running || this._stopping) return;
      const { probeDsh } = require('./health');
      const ok = await probeDsh(this.port, { timeoutMs: 3_000 });
      if (!this.running) return;
      if (ok) {
        this.healthFailures = 0;
        return;
      }
      this.healthFailures += 1;
      this._writeLog(`health probe failed (${this.healthFailures}/3)`, 'stderr');
      if (this.healthFailures >= 3) {
        this.stopHealthMonitor();
        onUnhealthy?.({ failures: this.healthFailures, port: this.port });
      }
    }, 7_500);
    this.healthTimer.unref?.();
  }

  stopHealthMonitor() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  async stop({ timeoutMs = 5_000 } = {}) {
    this._stopping = true;
    this.stopHealthMonitor();
    this._clearStartTimer();
    const child = this.child;
    if (!child) {
      this.ready = false;
      this._failReady(new DshStoppedError());
      this._closeLog();
      return;
    }

    const exited = this._exited ?? new Promise((resolve) => {
      this._resolveExited = resolve;
    });
    this._failReady(new DshStoppedError());

    try {
      child.kill('SIGTERM');
    } catch {
      // Already dead.
    }

    const graceful = await Promise.race([
      exited.then(() => true),
      delay(timeoutMs).then(() => false),
    ]);
    if (!graceful) {
      this._writeLog(`SIGTERM timeout; force-killing process tree ${child.pid}`, 'stderr');
      await killTree(child.pid);
      await Promise.race([exited, delay(2_000)]);
    }
    this.ready = false;
    this.child = null;
    this._closeLog();
  }
}

module.exports = { DshBackend, DshStoppedError, killTree };
