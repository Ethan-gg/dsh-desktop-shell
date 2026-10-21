'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { validatePackageSpec } = require('../backend/plugin-command');

let dialogOpen = false;

/**
 * Local, shell-owned input window. It has a tiny preload bridge because this
 * page is the only place the user can type a package spec; the page never
 * loads remote content and cannot navigate.
 *
 * @returns {Promise<string|null>} a validated spec, or null when cancelled.
 */
function openInstallDialog({ parent, appPath, initialValue = '', autoSubmit = false }) {
  if (dialogOpen) return Promise.resolve(null);
  dialogOpen = true;
  return new Promise((resolve) => {
    let win;
    try {
      win = new BrowserWindow({
        width: 560,
        height: 390,
        parent: parent && !parent.isDestroyed() ? parent : undefined,
        modal: true,
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        backgroundColor: '#0d1117',
        title: '安全安装插件',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          preload: path.join(__dirname, 'install-preload.js'),
          webviewTag: false,
        },
      });
    } catch {
      dialogOpen = false;
      resolve(null);
      return;
    }
    win.setMenuBarVisibility(false);

    let settled = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ipcMain.removeHandler('dsh-install:submit');
      ipcMain.removeListener('dsh-install:cancel', onCancel);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      dialogOpen = false;
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };
    const onCancel = (event) => {
      if (event.sender !== win.webContents) return;
      finish(null);
    };
    const onSubmit = (event, rawSpec) => {
      if (event.sender !== win.webContents) return { ok: false, error: '无效的窗口' };
      try {
        const spec = validatePackageSpec(rawSpec);
        finish(spec);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };

    ipcMain.handle('dsh-install:submit', onSubmit);
    ipcMain.on('dsh-install:cancel', onCancel);

    win.on('closed', () => {
      cleanup();
      dialogOpen = false;
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    win.webContents.once('did-finish-load', () => {
      if (!autoSubmit) return;
      const script = `document.getElementById('spec').value = ${JSON.stringify(initialValue)}; document.getElementById('submit').click();`;
      win.webContents.executeJavaScript(script).catch(() => {});
    });
    win.once('ready-to-show', () => win.show());
    win.loadFile(path.join(appPath, 'src', 'ui', 'install.html')).catch(() => finish(null));
  });
}

module.exports = { openInstallDialog };
