'use strict';

const { Menu, Tray, nativeImage } = require('electron');
const { APP_NAME } = require('../constants');

function phaseLabel(state) {
  switch (state.phase) {
    case 'starting': return '后端启动中…';
    case 'running': return state.port ? `后端运行中 · 127.0.0.1:${state.port}` : '后端运行中';
    case 'restarting': return state.restartInMs ? `后端将在 ${Math.ceil(state.restartInMs / 1000)} 秒后重启` : '后端重启中…';
    case 'rolling-back': return '正在回退配置…';
    case 'installing': return '正在安全安装插件…';
    case 'failed': return '后端未运行';
    default: return '后端未运行';
  }
}

function formatTime(iso) {
  try {
    const date = new Date(iso);
    return date.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

class TrayController {
  constructor({ iconPath, callbacks }) {
    this.callbacks = callbacks;
    this.state = { phase: 'starting', latestSnapshot: null, running: false, dshVersion: null, installing: false };
    this.tray = null;
    this.iconPath = iconPath;
  }

  create() {
    let image = nativeImage.createFromPath(this.iconPath);
    if (image.isEmpty()) {
      // A tiny transparent fallback keeps the tray alive even if assets are
      // missing; the menu is still fully usable.
      image = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVDhPYxgFg4GBAQAEEgAB7Y6nDgAAAABJRU5ErkJggg=='
      );
    }
    if (process.platform === 'darwin') image.setTemplateImage(true);
    this.tray = new Tray(image);
    this.tray.setToolTip(APP_NAME);
    this.tray.on('click', () => this.callbacks.show());
    this.tray.on('double-click', () => this.callbacks.show());
    this.update(this.state);
    return this.tray;
  }

  update(next = {}) {
    this.state = { ...this.state, ...next };
    if (!this.tray) return;

    const running = this.state.phase === 'running';
    const busy = this.state.phase === 'starting' || this.state.phase === 'restarting' || this.state.phase === 'rolling-back' || this.state.phase === 'installing';
    const snapshot = this.state.latestSnapshot;
    const snapshotLabel = snapshot
      ? `回退到可用配置（${formatTime(snapshot.createdAt)}）`
      : '回退到可用配置（暂无快照）';

    const template = [
      {
        label: this.state.phase === 'running' ? '显示 dsh' : '显示 dsh（后端未就绪）',
        click: () => this.callbacks.show(),
      },
      { label: phaseLabel(this.state), enabled: false },
      { label: this.state.dshVersion ? `dsh ${this.state.dshVersion}` : 'dsh 版本未知', enabled: false },
      { type: 'separator' },
      { label: '重新加载界面', enabled: running && !this.state.installing, click: () => this.callbacks.reload() },
      { label: '重启 dsh 后端', enabled: !busy && !this.state.installing, click: () => this.callbacks.restart() },
      { label: '安全安装插件（Canary）…', enabled: running && !busy && !this.state.installing, click: () => this.callbacks.install() },
      { type: 'separator' },
      { label: snapshotLabel, enabled: Boolean(snapshot) && !busy, click: () => this.callbacks.rollback() },
      { label: '保存当前配置为可用快照', enabled: !busy, click: () => this.callbacks.snapshot() },
      { type: 'separator' },
      { label: '打开配置目录', click: () => this.callbacks.openConfig() },
      { label: '打开日志目录', click: () => this.callbacks.openLogs() },
      {
        label: '开发者工具',
        enabled: running,
        click: () => this.callbacks.devtools(),
      },
      { type: 'separator' },
      { label: '退出', click: () => this.callbacks.quit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
    this.tray.setToolTip(`${APP_NAME} — ${phaseLabel(this.state)}`);
  }

  destroy() {
    this.tray?.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController, phaseLabel };
