'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_RE = /([?&]token=)[^&\s"'<>]+/gi;

function redact(value) {
  return String(value)
    .replace(/(\bhttps?:\/\/)([^/@\s]+)@/gi, '$1<redacted>@')
    .replace(TOKEN_RE, '$1<redacted>');
}

/**
 * Small synchronous file logger. Desktop startup produces little output, and
 * synchronous appends make crash diagnostics reliable without a flush dance.
 * Tokens are redacted before anything reaches the disk.
 */
class Logger {
  constructor(logDir, { maxBytes = 2 * 1024 * 1024, keep = 3 } = {}) {
    this.logDir = logDir;
    this.file = path.join(logDir, 'desktop.log');
    this.maxBytes = maxBytes;
    this.keep = keep;
    fs.mkdirSync(logDir, { recursive: true });
    this.rotateIfNeeded();
  }

  rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size <= this.maxBytes) return;
      for (let i = this.keep - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  write(level, message, extra) {
    const line = [
      new Date().toISOString(),
      level.toUpperCase(),
      redact(message),
      extra === undefined ? '' : redact(typeof extra === 'string' ? extra : JSON.stringify(extra)),
    ].filter(Boolean).join(' ');
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Logging must never take the app down.
    }
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    sink(`[dsh-desktop] ${line}`);
  }

  info(message, extra) { this.write('info', message, extra); }
  warn(message, extra) { this.write('warn', message, extra); }
  error(message, extra) { this.write('error', message, extra); }
}

module.exports = { Logger, redact, TOKEN_RE };
