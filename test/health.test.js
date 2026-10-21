'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeDsh, waitForDsh } = require('../src/backend/health');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('a 401 root is a healthy dsh', async () => {
  const server = await listen((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
  });
  try {
    assert.equal(await probeDsh(server.address().port), true);
  } finally {
    await close(server);
  }
});

test('a 2xx root is also accepted', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    assert.equal(await probeDsh(server.address().port), true);
  } finally {
    await close(server);
  }
});

test('5xx and 404 are not healthy', async () => {
  const server = await listen((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 500);
    res.end();
  });
  try {
    assert.equal(await probeDsh(server.address().port), false);
  } finally {
    await close(server);
  }
});

test('waitForDsh retries until the listener starts', async () => {
  const server = await listen((req, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    const port = server.address().port;
    assert.equal(await waitForDsh(port, { timeoutMs: 1_000, intervalMs: 50 }), true);
  } finally {
    await close(server);
  }
});

test('waitForDsh returns false for a closed port', async () => {
  assert.equal(await waitForDsh(1, { timeoutMs: 200, intervalMs: 50 }), false);
});
