'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RestartPolicy } = require('../src/backend/restart-policy');

test('backs off 2s, 5s, 15s, then gives up', () => {
  const policy = new RestartPolicy();
  policy.start(0);
  assert.deepEqual(policy.fail(1), { giveUp: false, failures: 1, delayMs: 2_000, attempt: 1 });
  assert.deepEqual(policy.fail(2), { giveUp: false, failures: 2, delayMs: 5_000, attempt: 2 });
  assert.deepEqual(policy.fail(3), { giveUp: false, failures: 3, delayMs: 15_000, attempt: 3 });
  assert.equal(policy.fail(4).giveUp, true);
  assert.equal(policy.failures, 4);
});

test('stable uptime resets the budget before counting the new failure', () => {
  const policy = new RestartPolicy({ stableMs: 60_000 });
  policy.start(0);
  policy.fail(10);
  policy.fail(20);
  assert.equal(policy.failures, 2);

  assert.deepEqual(policy.fail(60_000), {
    giveUp: false,
    failures: 1,
    delayMs: 2_000,
    attempt: 1,
  });
});

test('reset clears failures and startup time', () => {
  const policy = new RestartPolicy();
  policy.start(0);
  policy.fail(1);
  policy.reset();
  assert.equal(policy.failures, 0);
  assert.equal(policy.startedAt, null);
});
