'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { APP_ID, APP_DIR_NAME, APP_NAME } = require('./constants');
const { loadConfig } = require('./config');
const { Logger } = require('./logger');
const { DshBackend, killTree } = require('./backend/dsh-backend');
const { RestartPolicy } = require('./backend/restart-policy');
const { checkDshVersion } = require('./backend/version');
const { runDshPlugin } = require('./backend/plugin-command');
const { canaryName, createCanaryProfile, promoteCanaryProfile, removeCanaryProfile } = require('./profile/canary');
const { openInstallDialog } = require('./ui/install-dialog');
const { safeOrigin, redact } = require('./backend/url');
const {
  createSnapshot,
  fingerprintProfile,
  latestSnapshot,
  profileDirectory,
  restoreSnapshot,
} = require('./profile/snapshots');
const { statusDataUrl } = require('./ui/status-page');
const { isVisibleOnAnyDisplay, readWindowState, writeWindowState } = require('./ui/window-state');
const { TrayController } = require('./ui/tray');

const IS_SMOKE = process.argv.includes('--smoke-test') || process.env.DSH_DESKTOP_SMOKE === '1';
const IS_DEV = process.argv.includes('--dev');

app.setName(APP_NAME);
app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA
  ? path.resolve(process.env.DSH_DESKTOP_USER_DATA)
  : path.join(app.getPath('appData'), APP_DIR_NAME));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const state = {
  config: null,
  configPath: null,
  logger: null,
  backend: null,
  win: null,
  tray: null,
  phase: 'starting',
  port: null,
  lastUrl: null,
  origin: null,
  token: 0,
  policy: new RestartPolicy(),
  restartTimer: null,
  restartAt: 0,
  countdownTimer: null,
  stableTimer: null,
  snapshotsRoot: null,
  latestSnapshot: null,
  dshCompatibility: null,
  dshVersion: null,
  autoRollbackUsed: false,
  recovering: false,
  installing: false,
  pluginChild: null,
  quitting: false,
  fatalDialogOpen: false,
  allowInternalNavigation: false,
  loadingUrl: false,
  uiRetries: 0,
  uiRetryTimer: null,
  unresponsiveTimer: null,
  rendererCrashes: [],
  authWindows: new Set(),
  lastFailure: null,
  smokeDone: false,
  smokeStarted: false,
  smokeTimer: null,
  screenTimer: null,
};

function userData(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clearTimer(name) {
  if (state[name]) {
    clearTimeout(state[name]);
    clearInterval(state[name]);
    state[name] = null;
  }
}

function clearLifecycleTimers() {
  clearTimer('restartTimer');
  clearTimer('countdownTimer');
  clearTimer('stableTimer');
  clearTimer('uiRetryTimer');
  clearTimer('unresponsiveTimer');
  clearTimer('smokeTimer');
  state.restartAt = 0;
}

function updateUi() {
  if (!state.tray) return;
  state.tray.update({
    phase: state.phase,
    port: state.port,
    running: state.phase === 'running',
    restartInMs: state.restartAt > 0 ? Math.max(0, state.restartAt - Date.now()) : 0,
    latestSnapshot: state.latestSnapshot,
    dshVersion: state.dshVersion,
    installing: state.installing,
  });
}

async function showStatus(title, detail, tone = 'working') {
  if (!state.win || state.win.isDestroyed()) return;
  state.allowInternalNavigation = true;
  try {
    await state.win.loadURL(statusDataUrl({ title, detail, tone }));
  } catch {
    // A newer navigation may supersede this one; the latest load wins.
  } finally {
    state.allowInternalNavigation = false;
  }
}

function showWindow() {
  if (!state.win || state.win.isDestroyed()) return;
  if (state.win.isMinimized()) state.win.restore();
  state.win.show();
  state.win.focus();
}

function isAppUrl(value) {
  const origin = safeOrigin(value);
  return Boolean(origin && state.origin && origin === state.origin);
}

function isAllowedNavigation(value) {
  if (value === 'about:blank') return state.allowInternalNavigation;
  if (value.startsWith('data:text/html')) return state.allowInternalNavigation;
  return isAppUrl(value);
}

function openExternal(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return;
    void shell.openExternal(url.href).catch(() => {});
  } catch {
    // Ignore malformed or non-web URLs.
  }
}

function authPopupOptions() {
  return {
    width: 560,
    height: 760,
    minWidth: 420,
    minHeight: 520,
    parent: state.win ?? undefined,
    modal: false,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    title: 'dsh 登录',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  };
}

/**
 * DSH's browser login preopens `about:blank` on the user's click, then
 * navigates that tab to the platform authorization URL. Opening it in the
 * system browser loses the popup object and the Host's polling flow, so this
 * child window is the one deliberate exception: it is a sandboxed, Node-free
 * browser tab using the same session cookies.
 */
function configureAuthPopup(popup) {
  if (!popup || popup.isDestroyed()) return;
  state.authWindows.add(popup);
  popup.setMenuBarVisibility(false);
  if (state.win && !state.win.isDestroyed()) popup.setParentWindow(state.win);

  const { webContents } = popup;
  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url === 'about:blank') return;
    event.preventDefault();
  });
  webContents.on('will-redirect', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) return;
    event.preventDefault();
  });
  webContents.on('will-attach-webview', (event) => event.preventDefault());
  webContents.on('render-process-gone', () => {
    if (!popup.isDestroyed()) popup.close();
  });
  popup.on('closed', () => {
    state.authWindows.delete(popup);
  });
  state.logger?.info('已打开受限登录窗口（无 Node / 无 preload）');
}

async function loadAppUrl(url, attempt = 1) {
  if (!state.win || state.win.isDestroyed()) return false;
  if (!url || state.phase !== 'running') return false;
  state.loadingUrl = true;
  state.uiRetries = 0;
  try {
    await withTimeout(state.win.loadURL(url), 20_000, '页面加载超过 20 秒');
    return true;
  } catch (error) {
    if (state.quitting) return false;
    // A backend restart may have replaced the URL while this load was in
    // flight. Do not paint an error page over the new instance's UI.
    if (state.lastUrl !== url || state.phase !== 'running') return false;
    if (attempt < 3) {
      await delay(1_000 * attempt);
      if (state.lastUrl !== url || state.phase !== 'running') return false;
      return loadAppUrl(url, attempt + 1);
    }
    state.logger?.warn(`界面加载失败：${error.message}`);
    await showStatus(
      '界面加载失败',
      `本地后端正在运行，但页面没有成功加载。\n${error.message}\n\n可以按 F5 重试，或在托盘菜单中重启后端。`,
      'error'
    );
    return false;
  } finally {
    state.loadingUrl = false;
  }
}

function showMessageBox(options) {
  if (state.win && !state.win.isDestroyed()) return dialog.showMessageBox(state.win, options);
  return dialog.showMessageBox(options);
}

function createWindow() {
  const stateFile = userData('window-state.json');
  const saved = readWindowState(stateFile);
  const displays = screen.getAllDisplays();
  const bounds = {
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
  };
  if (saved.x === null || saved.y === null || !isVisibleOnAnyDisplay(bounds, displays)) {
    bounds.x = undefined;
    bounds.y = undefined;
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d1117',
    title: APP_NAME,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      backgroundThrottling: false,
      devTools: true,
    },
  });
  state.win = win;
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => {
    if (!state.config?.startHidden || IS_SMOKE) showWindow();
  });

  win.on('close', (event) => {
    if (state.quitting) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    if (state.win === win) state.win = null;
  });

  win.on('resize', () => {
    clearTimeout(state.screenTimer);
    state.screenTimer = setTimeout(() => writeWindowState(stateFile, win), 500);
  });
  win.on('move', () => {
    clearTimeout(state.screenTimer);
    state.screenTimer = setTimeout(() => writeWindowState(stateFile, win), 500);
  });

  const { webContents } = win;

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = String(input.key || '').toLowerCase();

    // Ctrl+Shift+R must be checked before Ctrl+R.
    if (mod && input.shift && key === 'r') {
      event.preventDefault();
      void manualRestart('shortcut');
      return;
    }
    if (input.key === 'F5' || (mod && key === 'r' && !input.shift)) {
      event.preventDefault();
      void reloadUi();
      return;
    }
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      if (!webContents.isDevToolsOpened()) webContents.openDevTools({ mode: 'detach' });
      else webContents.closeDevTools();
    }
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank') {
      return { action: 'allow', overrideBrowserWindowOptions: authPopupOptions() };
    }
    if (isAppUrl(url)) {
      setImmediate(() => { void loadAppUrl(url); });
    } else {
      openExternal(url);
    }
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (childWindow) => {
    configureAuthPopup(childWindow);
  });

  webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  webContents.on('did-finish-load', () => {
    state.uiRetries = 0;
  });

  webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 || state.loadingUrl) return;
    if (state.phase !== 'running' || !isAppUrl(validatedURL) || state.uiRetryTimer) return;
    state.uiRetries += 1;
    state.logger?.warn(`页面加载失败 (${code})：${description}`);
    if (state.uiRetries > 3) {
      void showStatus('界面加载失败', `${description || '未知错误'}\n\n请按 F5，或在托盘菜单中重启后端。`, 'error');
      return;
    }
    state.uiRetryTimer = setTimeout(() => {
      state.uiRetryTimer = null;
      if (state.phase === 'running' && state.lastUrl) void loadAppUrl(state.lastUrl);
    }, 1_000 * state.uiRetries);
  });

  webContents.on('render-process-gone', (_event, details) => {
    state.logger?.error(`渲染进程退出：${details.reason} (exitCode=${details.exitCode})`);
    if (state.quitting) return;
    const now = Date.now();
    state.rendererCrashes = state.rendererCrashes.filter((time) => now - time < 60_000);
    state.rendererCrashes.push(now);
    if (state.rendererCrashes.length > 3) {
      state.rendererCrashes = [];
      void manualRestart('renderer-crash');
      return;
    }
    setTimeout(() => {
      if (state.phase === 'running' && state.lastUrl) void loadAppUrl(state.lastUrl);
    }, 800);
  });

  webContents.on('unresponsive', () => {
    state.logger?.warn('页面无响应');
    clearTimer('unresponsiveTimer');
    state.unresponsiveTimer = setTimeout(() => {
      state.unresponsiveTimer = null;
      if (state.quitting) return;
      state.logger?.warn('页面持续无响应，自动重新加载');
      void reloadUi();
    }, 10_000);
  });

  webContents.on('responsive', () => {
    clearTimer('unresponsiveTimer');
    state.logger?.info('页面恢复响应');
  });

  webContents.on('devtools-opened', () => {
    if (!IS_DEV) state.logger?.info('开发者工具已打开');
  });

  void showStatus('正在启动 dsh 后端', '正在启动本地 dsh 服务，并等待它完成初始化…');
  return win;
}

function applySessionPolicy() {
  const allowedPermissions = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications']);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = safeOrigin(details?.requestingUrl || webContents?.getURL?.() || '');
    callback(Boolean(origin && origin === state.origin && allowedPermissions.has(permission)));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    const origin = safeOrigin(requestingOrigin);
    return Boolean(origin && origin === state.origin && allowedPermissions.has(permission));
  });
}

async function snapshotAfterReady() {
  try {
    const snapshot = createSnapshot({
      root: state.snapshotsRoot,
      dshHome: state.config.dshHome,
      profile: state.config.profile,
      reason: 'startup-ready',
    });
    if (snapshot) {
      state.latestSnapshot = snapshot;
      state.logger?.info(`可用配置快照：${snapshot.createdAt} (${snapshot.hash.slice(0, 8)})`);
    }
  } catch (error) {
    state.logger?.warn(`保存配置快照失败：${error.message}`);
  }
}

function startCountdown() {
  clearTimer('countdownTimer');
  state.countdownTimer = setInterval(() => {
    if (!state.restartAt) return;
    updateUi();
    if (Date.now() >= state.restartAt) clearTimer('countdownTimer');
  }, 1_000);
  state.countdownTimer.unref?.();
}

async function stopBackend() {
  const backend = state.backend;
  state.backend = null;
  if (!backend) return;
  try {
    await backend.stop();
  } catch (error) {
    state.logger?.warn(`停止 dsh 后端失败：${error.message}`);
  }
}

function scheduleStableReset() {
  clearTimer('stableTimer');
  if (state.phase !== 'running') return;
  state.stableTimer = setTimeout(() => {
    if (state.phase !== 'running') return;
    state.policy.reset();
    state.autoRollbackUsed = false;
    state.logger?.info('后端稳定运行 60 秒，重启预算与自动回滚标记已重置');
  }, 60_000);
  state.stableTimer.unref?.();
}

async function startBackend(reason, { manual = false } = {}) {
  const myToken = ++state.token;
  clearLifecycleTimers();

  if (manual) {
    state.policy.reset();
    state.autoRollbackUsed = false;
  }

  state.phase = 'starting';
  state.port = null;
  state.lastUrl = null;
  state.origin = null;
  updateUi();
  await stopBackend();
  if (myToken !== state.token || state.quitting) return;

  state.phase = 'starting';
  updateUi();
  await showStatus(
    reason === 'manual' ? '正在重启 dsh 后端' : '正在启动 dsh 后端',
    '正在启动本地 dsh 服务，并等待它完成初始化…\n首次启动或插件较多时可能需要更久。'
  );
  if (myToken !== state.token || state.quitting) return;

  const backend = new DshBackend({
    config: state.config,
    logger: state.logger,
    appPath: app.getAppPath(),
    version: state.dshVersion,
  });
  state.backend = backend;

  backend.on('exit', (info) => {
    if (state.backend !== backend) return;
    state.backend = null;
    if (state.quitting || myToken !== state.token) return;
    state.logger?.warn(`dsh 后端退出：code=${info.code} signal=${info.signal} uptimeMs=${info.uptimeMs}`);
    if (state.phase !== 'running') return;
    void handleBackendFailure(new Error(`dsh 后端意外退出（code=${info.code ?? 'null'}）。`), 'exit');
  });

  backend.on('unhealthy', (info) => {
    if (state.backend !== backend) return;
    if (state.quitting || myToken !== state.token || state.phase !== 'running') return;
    state.logger?.warn(`dsh 后端健康检查连续失败 ${info.failures} 次`);
    void manualRestart('health', { manual: false });
  });

  try {
    const info = await backend.start();
    if (myToken !== state.token || state.backend !== backend || state.quitting) {
      await backend.stop().catch(() => {});
      return;
    }

    state.phase = 'running';
    state.port = info.port;
    state.lastUrl = info.url;
    state.origin = safeOrigin(info.url);
    state.policy.start();
    updateUi();
    state.logger?.info(`dsh 后端就绪：pid=${info.pid} port=${info.port}`);

    // Start watching liveness before loading the page; a UI that hangs must
    // not prevent the health monitor from noticing a dead backend.
    backend.startHealthMonitor((health) => {
      if (state.backend !== backend) return;
      if (state.quitting || state.phase !== 'running') return;
      state.logger?.warn(`健康检查连续失败 ${health.failures} 次，重启后端`);
      void manualRestart('health', { manual: false });
    });

    // Snapshot immediately after a proven boot, before the user can install a
    // plugin in the freshly opened UI.
    await snapshotAfterReady();
    updateUi();

    await loadAppUrl(info.url);
    if (!state.config.startHidden || IS_SMOKE) showWindow();
    scheduleStableReset();

    if (IS_DEV) {
      state.win?.webContents.openDevTools({ mode: 'detach' });
    }
    if (IS_SMOKE) scheduleSmokeCapture();
  } catch (error) {
    if (myToken !== state.token) return;
    state.logger?.error(`启动 dsh 后端失败：${error.message}`);
    state.lastFailure = error;
    await backend.stop().catch(() => {});
    if (state.backend === backend) state.backend = null;
    if (state.quitting) return;
    void handleBackendFailure(error, 'start');
  }
}

function handleBackendFailure(error, kind) {
  if (state.quitting || state.recovering || state.installing) return;
  state.lastFailure = error;
  state.phase = 'failed';
  state.port = null;
  state.origin = null;
  updateUi();

  const decision = state.policy.fail();
  if (!decision.giveUp) {
    state.phase = 'restarting';
    state.restartAt = Date.now() + decision.delayMs;
    updateUi();
    startCountdown();
    void showStatus(
      '后端暂时不可用',
      `第 ${decision.attempt} 次自动恢复将在 ${Math.ceil(decision.delayMs / 1000)} 秒后进行。\n\n` +
      `${redact(error.message).split('\n').slice(0, 5).join('\n')}`,
      'warn'
    );
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      state.restartAt = 0;
      void startBackend('auto', { manual: false });
    }, decision.delayMs);
    state.restartTimer.unref?.();
    return;
  }

  state.phase = 'failed';
  state.restartAt = 0;
  updateUi();
  void recoverOrFatal(error, kind);
}

async function recoverOrFatal(error, kind) {
  if (state.quitting || state.recovering || state.installing) return;
  state.recovering = true;
  try {
    const profileDir = profileDirectory(state.config.dshHome, state.config.profile);
    const currentHash = fingerprintProfile(profileDir);
    const latest = latestSnapshot(state.snapshotsRoot, state.config.profile);
    const canRollback = Boolean(
      latest &&
      !state.autoRollbackUsed &&
      currentHash &&
      latest.hash !== currentHash
    );

    if (canRollback) {
      state.autoRollbackUsed = true;
      state.phase = 'rolling-back';
      updateUi();
      state.logger?.warn(`启动连续失败，自动回退到 ${latest.createdAt} 的可用配置`);
      await showStatus(
        '正在回退到可用配置',
        `后端连续启动失败。正在恢复 ${new Date(latest.createdAt).toLocaleString('zh-CN')} 保存的配置快照，` +
        '然后重新启动。\n你的会话、凭据和缓存不会受到影响。'
      );
      await stopBackend();
      if (state.quitting) return;
      let meta;
      try {
        meta = restoreSnapshot(latest, profileDir);
      } catch (restoreError) {
        state.logger?.error(`自动回退配置失败：${restoreError.message}`);
        state.phase = 'failed';
        updateUi();
        await showFatalDialog(restoreError, 'rollback');
        return;
      }
      state.latestSnapshot = latest;
      state.policy.reset();
      state.recovering = false;
      state.logger?.info(`已回退配置快照 ${meta.createdAt}，正在重启后端`);
      await startBackend('rollback', { manual: false });
      return;
    }

    state.phase = 'failed';
    updateUi();
    await showStatus(
      'dsh 后端无法启动',
      `${redact(error.message).split('\n').slice(0, 8).join('\n')}\n\n` +
      '可以在托盘菜单中打开日志，或手动回退配置。',
      'error'
    );
    showWindow();
    await showFatalDialog(error, kind);
  } finally {
    state.recovering = false;
  }
}

async function showFatalDialog(error, kind) {
  if (state.fatalDialogOpen || state.quitting) return;
  if (IS_SMOKE) {
    state.logger?.error(`冒烟测试失败：${redact(error.message)}`);
    console.error(`SMOKE_FAIL ${redact(error.stack || error.message)}`);
    await shutdown(1);
    return;
  }
  state.fatalDialogOpen = true;
  const logDir = userData('logs');
  try {
    const result = await showMessageBox({
      type: 'error',
      title: 'dsh 后端无法启动',
      message: 'dsh 后端连续启动失败。',
      detail: `${redact(error.message)}\n\n${kind === 'exit' ? '进程已退出。' : ''}\n日志目录：${logDir}`,
      buttons: ['重启后端', '回退配置', '打开日志', '退出'],
      defaultId: 2,
      cancelId: 3,
      noLink: true,
    });
    if (state.quitting) return;
    // The dialog is entered from recoverOrFatal, which keeps `recovering`
    // true. Clear it before starting another backend so a failed restart can
    // enter recovery again instead of being silently ignored.
    state.recovering = false;
    if (result.response === 0) {
      state.policy.reset();
      state.autoRollbackUsed = false;
      await startBackend('manual', { manual: true });
    } else if (result.response === 1) {
      await rollbackProfile({ automatic: false, confirm: false });
    } else if (result.response === 2) {
      await shell.openPath(logDir);
    } else {
      void shutdown(1);
    }
  } catch {
    // Dialog can reject while the app is shutting down.
  } finally {
    state.fatalDialogOpen = false;
  }
}

async function manualRestart(reason = 'manual', { manual = true } = {}) {
  if (state.quitting || state.installing) return;
  if (state.recovering) return;
  await startBackend(reason, { manual });
}

async function reloadUi() {
  if (state.quitting || state.installing) return;
  if (state.phase === 'running' && state.lastUrl) {
    await loadAppUrl(state.lastUrl);
    return;
  }
  if (state.phase === 'failed') await manualRestart('reload');
}

async function rollbackProfile({ automatic = false, confirm = !automatic } = {}) {
  if (state.quitting || state.installing) return;
  const latest = latestSnapshot(state.snapshotsRoot, state.config.profile);
  if (!latest) {
    if (!automatic) {
      await showMessageBox({
        type: 'info',
        title: '没有可用快照',
        message: '还没有保存过可用的配置快照。',
        detail: '后端成功启动一次后，会自动保存当前 profile 的配置快照。',
        buttons: ['知道了'],
      });
    }
    return;
  }

  if (confirm) {
    const result = await showMessageBox({
      type: 'warning',
      title: '回退配置',
      message: `回退到 ${new Date(latest.createdAt).toLocaleString('zh-CN')} 的配置快照？`,
      detail: '只会恢复 profile 的 package.json 和 cordis 配置文件；会话、凭据、缓存、已安装的包都不会被删除。',
      buttons: ['回退并重启', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) return;
  }

  state.logger?.warn(`手动回退到配置快照 ${latest.createdAt} (${latest.hash.slice(0, 8)})`);
  state.phase = 'rolling-back';
  updateUi();
  await stopBackend();
  if (state.quitting) return;
  try {
    restoreSnapshot(latest, profileDirectory(state.config.dshHome, state.config.profile));
    state.latestSnapshot = latest;
    state.policy.reset();
    state.autoRollbackUsed = false;
    await startBackend('rollback', { manual: false });
  } catch (error) {
    state.logger?.error(`回退配置失败：${error.message}`);
    await showMessageBox({
      type: 'error',
      title: '回退失败',
      message: '配置快照恢复失败。',
      detail: error.message,
      buttons: ['知道了'],
    });
    state.phase = 'failed';
    updateUi();
  }
}

async function saveSnapshotManually() {
  try {
    const snapshot = createSnapshot({
      root: state.snapshotsRoot,
      dshHome: state.config.dshHome,
      profile: state.config.profile,
      reason: 'manual',
      force: true,
    });
    state.latestSnapshot = snapshot ?? state.latestSnapshot;
    updateUi();
    await showMessageBox({
      type: 'info',
      title: '已保存配置快照',
      message: snapshot ? '当前 profile 配置已保存为可用快照。' : 'profile 目录不存在，没有保存快照。',
      detail: snapshot ? snapshot.directory : '',
      buttons: ['知道了'],
    });
  } catch (error) {
    state.logger?.error(`保存配置快照失败：${error.message}`);
  }
}

async function installPluginSafely() {
  if (state.quitting || state.installing) return;
  if (state.phase !== 'running') {
    await showMessageBox({
      type: 'info',
      title: '后端未就绪',
      message: '请先等 dsh 后端正常启动，再安装插件。',
      buttons: ['知道了'],
    });
    return;
  }

  showWindow();
  const appPath = app.getAppPath();
  const smokeSpec = IS_SMOKE ? process.env.DSH_DESKTOP_SMOKE_INSTALL_SPEC : null;
  const spec = await openInstallDialog({
    parent: state.win,
    appPath,
    initialValue: smokeSpec ?? '',
    autoSubmit: Boolean(smokeSpec),
  });
  if (!spec || state.quitting) return false;

  const activeProfile = state.config.profile;
  const canary = canaryName(activeProfile);
  const activeDir = profileDirectory(state.config.dshHome, activeProfile);
  const canaryConfig = { ...state.config, profile: canary };
  let preSnapshot = null;
  let canaryCreated = false;

  state.installing = true;
  state.phase = 'installing';
  updateUi();
  try {
    preSnapshot = createSnapshot({
      root: state.snapshotsRoot,
      dshHome: state.config.dshHome,
      profile: activeProfile,
      reason: 'pre-plugin-install',
      force: true,
    });
    if (!preSnapshot) throw new Error('当前 profile 不存在，无法创建安装前快照。');

    await showStatus(
      '正在准备 Canary 配置',
      `插件：${spec}\n\n正在停止当前后端并复制一份 profile 配置；会话、凭据和已安装的包不会被复制。`
    );
    showWindow();
    await stopBackend();
    if (state.quitting) return;

    const created = createCanaryProfile({ dshHome: state.config.dshHome, profile: activeProfile });
    canaryCreated = true;
    state.logger.info(`已创建 Canary profile ${canary}${created.linkedModules ? '（共享 node_modules）' : ''}`);

    await showStatus(
      '正在安装插件（Canary）',
      `插件：${spec}\n\n正在 canary profile 中执行 dsh plugin add。\n首次下载或构建可能需要几分钟，当前后端已暂停。`
    );
    await runDshPlugin({
      config: canaryConfig,
      appPath,
      args: ['add', spec],
      onSpawn: (child) => { state.pluginChild = child; },
    });
    state.pluginChild = null;

    await showStatus('正在验证 Canary 后端', '插件已安装，正在用独立端口启动 canary profile，确认它能真正加载。');
    const probe = new DshBackend({
      config: canaryConfig,
      logger: state.logger,
      appPath,
      version: state.dshVersion,
    });
    try {
      const info = await probe.start();
      state.logger.info(`Canary 验证通过：pid=${info.pid} port=${info.port}`);
    } finally {
      await probe.stop().catch(() => {});
    }

    await showStatus('正在合并配置', 'Canary 验证通过，正在把配置合并回当前 profile 并重启。');
    promoteCanaryProfile({ dshHome: state.config.dshHome, profile: activeProfile });
    state.logger.info(`已将 Canary 配置合并到 profile ${activeProfile}`);

    await startBackend('plugin-install', { manual: true });
    await delay(2_000);
    if (state.phase !== 'running') throw new Error('合并配置后，正式后端没有进入运行状态。');

    await snapshotAfterReady();
    const postSnapshot = createSnapshot({
      root: state.snapshotsRoot,
      dshHome: state.config.dshHome,
      profile: activeProfile,
      reason: 'post-plugin-install',
      force: true,
    });
    if (postSnapshot) state.latestSnapshot = postSnapshot;
    updateUi();

    if (IS_SMOKE) {
      console.log(`SMOKE_INSTALL_OK ${redact(spec)}`);
    } else {
      await showMessageBox({
        type: 'info',
        title: '插件安装成功',
        message: `${redact(spec)} 已通过 Canary 验证并合并到当前 profile。`,
        detail: postSnapshot ? `新配置快照：${postSnapshot.directory}` : '插件已生效。',
        buttons: ['知道了'],
      });
    }
    return true;
  } catch (error) {
    state.logger.error(`安全安装插件失败：${error.message}`);
    state.pluginChild = null;
    if (state.quitting) return false;
    clearLifecycleTimers();
    await stopBackend();
    let restored = false;
    if (preSnapshot) {
      try {
        restoreSnapshot(preSnapshot, activeDir);
        state.latestSnapshot = preSnapshot;
        restored = true;
        state.logger.warn('已恢复安装前配置快照');
      } catch (restoreError) {
        state.logger.error(`恢复安装前快照失败：${restoreError.message}`);
      }
    }
    await startBackend('plugin-install-rollback', { manual: true });
    if (state.quitting) return false;
    if (IS_SMOKE) {
      console.error(`SMOKE_INSTALL_FAIL ${redact(error.message)}`);
    } else {
      await showMessageBox({
        type: 'error',
        title: '插件安装失败',
        message: '插件没有通过 Canary 验证，已保留原配置。',
        detail: `${redact(error.message)}\n\n${restored ? '已恢复安装前配置快照。' : '未能恢复安装前快照，请检查日志。'}`,
        buttons: ['知道了'],
      });
    }
    return false;
  } finally {
    state.installing = false;
    state.pluginChild = null;
    if (canaryCreated) {
      try {
        removeCanaryProfile({ dshHome: state.config.dshHome, profile: activeProfile });
        state.logger.info(`已清理 Canary profile ${canary}`);
      } catch (cleanupError) {
        state.logger.warn(`清理 Canary profile 失败：${cleanupError.message}`);
      }
    }
    updateUi();
  }
}

function scheduleSmokeCapture() {
  if (!IS_SMOKE || state.smokeStarted || state.smokeDone) return;
  state.smokeStarted = true;
  clearTimer('smokeTimer');
  state.smokeTimer = setTimeout(() => {
    void runSmoke();
  }, 2_500);
  state.smokeTimer.unref?.();
}

async function captureSmoke(file) {
  const image = await state.win.webContents.capturePage();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  const title = await state.win.webContents.executeJavaScript('document.title').catch(() => null);
  return { file, title, port: state.port, pid: state.backend?.child?.pid ?? null };
}

async function runSmoke() {
  if (state.smokeDone) return;
  try {
    const out = process.env.DSH_DESKTOP_SMOKE_OUT || userData('smoke.png');
    const first = await captureSmoke(out);
    let second = null;
    let restart = null;
    let oauthPopup = null;
    let install = null;

    if (process.env.DSH_DESKTOP_SMOKE_INSTALL === '1') {
      const installSpec = process.env.DSH_DESKTOP_SMOKE_INSTALL_SPEC;
      if (!installSpec) throw new Error('DSH_DESKTOP_SMOKE_INSTALL_SPEC is required');
      const ok = await installPluginSafely();
      await delay(1_500);
      if (!ok) throw new Error('safe plugin install returned failure');
      if (state.phase !== 'running') throw new Error(`after install phase is ${state.phase}`);
      const packageName = process.env.DSH_DESKTOP_SMOKE_INSTALL_PACKAGE || 'dsh-desktop-demo-plugin';
      const profileDir = profileDirectory(state.config.dshHome, state.config.profile);
      const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
      if (!manifest.dependencies?.[packageName]) throw new Error('installed dependency missing from active profile');
      install = { ok: true, spec: redact(installSpec), packageName, port: state.port, phase: state.phase };
    }

    if (process.env.DSH_DESKTOP_SMOKE_OAUTH === '1') {
      const before = state.authWindows.size;
      await state.win.webContents.executeJavaScript(
        "void window.open('about:blank', '_blank'); undefined",
        true
      );
      await delay(600);
      const popups = [...state.authWindows];
      const popup = popups.at(-1);
      if (!popup || state.authWindows.size !== before + 1) throw new Error('OAuth popup was not created');
      const prefs = popup.webContents.getLastWebPreferences();
      if (!prefs || prefs.nodeIntegration !== false || prefs.sandbox !== true || prefs.preload) {
        throw new Error('OAuth popup has unsafe webPreferences');
      }
      oauthPopup = { sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, hasPreload: Boolean(prefs.preload) };
      for (const item of popups) {
        if (!item.isDestroyed()) item.close();
      }
    }

    if (process.env.DSH_DESKTOP_SMOKE_RESTART === '1') {
      const firstPort = state.port;
      await manualRestart('smoke-restart', { manual: true });
      await delay(2_500);
      if (state.phase !== 'running') throw new Error(`重启后端后状态为 ${state.phase}`);
      if (state.port === firstPort) throw new Error('重启后端后端口没有变化');
      second = await captureSmoke(out.replace(/\.png$/u, '.2.png'));
      restart = { firstPort, secondPort: state.port };
    }

    const status = {
      ok: true,
      url: state.lastUrl ? redact(state.lastUrl) : null,
      port: state.port,
      pid: state.backend?.child?.pid ?? null,
      snapshot: Boolean(state.latestSnapshot),
      screenshot: first.file,
      title: first.title,
      secondScreenshot: second?.file ?? null,
      secondTitle: second?.title ?? null,
      restart,
      oauthPopup,
      install,
    };
    fs.writeFileSync(`${out}.json`, `${JSON.stringify(status, null, 2)}\n`);
    state.smokeDone = true;
    console.log(`SMOKE_OK ${JSON.stringify(status)}`);
    await shutdown(0);
  } catch (error) {
    state.smokeDone = true;
    console.error(`SMOKE_FAIL ${redact(error.stack || error.message)}`);
    await shutdown(1);
  }
}

async function shutdown(code = 0) {
  if (state.quitting) return;
  state.quitting = true;
  clearLifecycleTimers();
  clearTimeout(state.screenTimer);
  state.screenTimer = null;
  updateUi();
  state.logger?.info(`退出应用 (code=${code})`);
  try {
    if (state.pluginChild?.pid) {
      await killTree(state.pluginChild.pid);
      state.pluginChild = null;
    }
    await stopBackend();
  } finally {
    if (state.win && !state.win.isDestroyed()) {
      writeWindowState(userData('window-state.json'), state.win);
    }
    state.tray?.destroy();
    state.tray = null;
    app.exit(code);
  }
}

function createTray() {
  const tray = new TrayController({
    iconPath: path.join(app.getAppPath(), 'assets', 'tray.png'),
    callbacks: {
      show: showWindow,
      reload: () => { void reloadUi(); },
      restart: () => { void manualRestart('tray'); },
      install: () => { void installPluginSafely(); },
      rollback: () => { void rollbackProfile({ automatic: false }); },
      snapshot: () => { void saveSnapshotManually(); },
      openConfig: () => { void shell.openPath(path.dirname(state.configPath)); },
      openLogs: () => { void shell.openPath(userData('logs')); },
      devtools: () => {
        if (state.win && !state.win.webContents.isDevToolsOpened()) {
          state.win.webContents.openDevTools({ mode: 'detach' });
        }
      },
      quit: () => { void shutdown(0); },
    },
  });
  state.tray = tray;
  tray.create();
  updateUi();
}

function installCrashLogging() {
  process.on('uncaughtException', (error) => {
    state.logger?.error(`uncaughtException: ${error.stack || error.message}`);
    if (!state.quitting && !state.fatalDialogOpen) {
      dialog.showErrorBox('dsh Desktop 发生未处理错误', redact(error.stack || error.message));
    }
  });
  process.on('unhandledRejection', (reason) => {
    state.logger?.warn(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

async function bootstrap() {
  installCrashLogging();
  fs.mkdirSync(userData(), { recursive: true });
  const defaultWorkspace = (() => {
    try { return app.getPath('documents'); } catch { return app.getPath('home'); }
  })();

  const loaded = loadConfig({ userDataDir: userData(), defaultWorkspace });
  state.config = loaded.config;
  state.config.userDataDir = userData();
  state.configPath = loaded.configPath;
  state.snapshotsRoot = userData('profile-snapshots');
  state.latestSnapshot = latestSnapshot(state.snapshotsRoot, state.config.profile);
  state.logger = new Logger(userData('logs'));
  state.logger.info(`启动 ${APP_NAME}`);
  state.logger.info(`配置：${state.configPath}`);
  state.logger.info(`DSH_HOME=${state.config.dshHome}, profile=${state.config.profile}, workspace=${state.config.workspace}`);
  if (loaded.created) state.logger.info('已生成默认 desktop-config.json');

  try {
    const compatibility = await checkDshVersion({ config: state.config, appPath: app.getAppPath() });
    state.dshCompatibility = compatibility;
    state.dshVersion = compatibility.version?.raw ?? null;
    state.logger.info(`dsh 版本：${state.dshVersion ?? '未知'}（${compatibility.status}）`);
    if (compatibility.status === 'too-old' || compatibility.status === 'untested' || compatibility.status === 'unknown') {
      state.logger.warn(compatibility.message);
    }
  } catch (error) {
    state.dshCompatibility = { status: 'unknown', message: error.message };
    state.logger.warn(`无法检查 dsh 版本：${error.message}`);
  }

  await app.whenReady();
  Menu.setApplicationMenu(null);
  applySessionPolicy();
  createWindow();
  createTray();

  app.on('activate', () => showWindow());

  if (IS_SMOKE) {
    setTimeout(() => {
      if (state.smokeDone) return;
      state.smokeDone = true;
      console.error('SMOKE_FAIL timeout waiting for backend');
      void shutdown(1);
    }, 90_000).unref?.();
  }

  await startBackend('startup', { manual: true });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('before-quit', (event) => {
    if (state.quitting) return;
    event.preventDefault();
    void shutdown(0);
  });

  app.on('second-instance', () => showWindow());

  app.on('window-all-closed', () => {
    // The tray owns the lifecycle; closing the window only hides it.
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(bootstrap).catch(async (error) => {
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: `${APP_NAME} 启动失败`,
        message: redact(error.message),
        detail: error.stack ? redact(error.stack) : '',
        buttons: ['退出'],
      });
    } catch {
      // Headless failure; fall through to a non-zero exit.
    }
    app.exit(1);
  });
}
