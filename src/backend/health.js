'use strict';

const http = require('node:http');

/**
 * Probe a dsh Web listener without the launch token.
 *
 * A healthy dsh answers the root with 401 (no browser cookie) or a 2xx/3xx
 * when a cookie is already present. A bare "status < 500" check, as in the
 * original plan, would also accept an unrelated HTTP service; this one pins
 * the expected authentication response and is only used for a child we own.
 */
function probeDsh(port, { host = '127.0.0.1', timeoutMs = 2_500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let hardTimer = null;
    let req = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve(value);
    };

    hardTimer = setTimeout(() => {
      try { req?.destroy(); } catch { /* already closed */ }
      finish(false);
    }, timeoutMs + 500);

    req = http.request({
      host,
      port,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'user-agent': 'dsh-desktop-shell/health',
        'cache-control': 'no-cache',
        connection: 'close',
      },
    }, (res) => {
      res.resume();
      const code = res.statusCode ?? 0;
      res.on('end', () => finish(code === 401 || (code >= 200 && code < 400)));
      res.on('error', () => finish(false));
    });

    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end();
  });
}

async function waitForDsh(port, { timeoutMs = 10_000, intervalMs = 250, ...options } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probeDsh(port, options)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return false;
}

module.exports = { probeDsh, waitForDsh };
