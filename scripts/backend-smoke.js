'use strict';

/**
 * Headless integration check for the backend supervisor:
 *   node scripts/backend-smoke.js
 *
 * It starts dsh twice, proves each instance prints a different authenticated
 * URL/port, and proves both children are gone on stop. This uses the real
 * DSH_HOME and web profile, so it exercises the same startup path as the app.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DshBackend } = require('../src/backend/dsh-backend');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/logger');

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-backend-smoke-'));
  const loaded = loadConfig({ userDataDir, defaultWorkspace: os.homedir() });
  loaded.config.userDataDir = userDataDir;
  const logger = new Logger(path.join(userDataDir, 'logs'));
  const results = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const backend = new DshBackend({
        config: loaded.config,
        logger,
        appPath: path.resolve(__dirname, '..'),
      });
      const info = await backend.start();
      const status = backend.getStatus();
      if (!info.url || !info.port || !status.running) throw new Error('backend did not report a ready URL');
      results.push({ port: info.port, pid: info.pid, up: status.running });
      await backend.stop();
      if (backend.running) throw new Error('backend still running after stop');
    }
    if (results[0].port === results[1].port) throw new Error('ephemeral ports did not change');
    console.log(JSON.stringify({ ok: true, instances: results }, null, 2));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
