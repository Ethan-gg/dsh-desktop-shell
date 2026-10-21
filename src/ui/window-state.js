'use strict';

const fs = require('node:fs');

const DEFAULT_STATE = Object.freeze({ width: 1280, height: 860, x: null, y: null, maximized: false });

function readWindowState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
    return {
      width: Number.isFinite(raw.width) ? Math.max(900, Math.round(raw.width)) : DEFAULT_STATE.width,
      height: Number.isFinite(raw.height) ? Math.max(600, Math.round(raw.height)) : DEFAULT_STATE.height,
      x: Number.isFinite(raw.x) ? Math.round(raw.x) : null,
      y: Number.isFinite(raw.y) ? Math.round(raw.y) : null,
      maximized: Boolean(raw.maximized),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function isVisibleOnAnyDisplay(bounds, displays) {
  if (!Array.isArray(displays) || displays.length === 0) return false;
  return displays.some(({ workArea }) => {
    if (!workArea) return false;
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX >= 80 && overlapY >= 80;
  });
}

function writeWindowState(file, win) {
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(file, `${JSON.stringify({
      ...bounds,
      maximized: win.isMaximized(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Window state is a convenience only.
  }
}

module.exports = { DEFAULT_STATE, isVisibleOnAnyDisplay, readWindowState, writeWindowState };
