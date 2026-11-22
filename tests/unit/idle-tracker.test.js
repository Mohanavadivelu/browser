'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdleTracker } = require('../../src/main/idle-tracker');

function createTracker(idleMs = 5000) {
  const clock = { time: 0 };
  const events = [];
  const tracker = new IdleTracker({
    idleMs,
    now: () => clock.time,
    onIdle: () => events.push('idle'),
    onActive: () => events.push('active'),
  });
  return { tracker, clock, events };
}

test('goes idle only after the full idle period without activity', () => {
  const { tracker, clock, events } = createTracker();
  tracker.enable();
  clock.time = 4999;
  tracker.check();
  assert.deepEqual(events, []);
  clock.time = 5000;
  tracker.check();
  assert.deepEqual(events, ['idle']);
  tracker.check();
  assert.deepEqual(events, ['idle']);
});

test('activity restarts the countdown and wakes an idle tracker', () => {
  const { tracker, clock, events } = createTracker();
  tracker.enable();
  clock.time = 4000;
  tracker.activity();
  clock.time = 8000;
  tracker.check();
  assert.deepEqual(events, []);
  clock.time = 9000;
  tracker.check();
  tracker.activity();
  assert.deepEqual(events, ['idle', 'active']);
});

test('enabling twice does not reset the countdown', () => {
  const { tracker, clock, events } = createTracker();
  assert.equal(tracker.enable(), true);
  clock.time = 3000;
  assert.equal(tracker.enable(), false);
  clock.time = 5000;
  tracker.check();
  assert.deepEqual(events, ['idle']);
});

test('disabling while idle restores activity and stops tracking', () => {
  const { tracker, clock, events } = createTracker();
  tracker.enable();
  clock.time = 6000;
  tracker.check();
  tracker.disable();
  assert.deepEqual(events, ['idle', 'active']);
  clock.time = 20000;
  tracker.check();
  tracker.activity();
  assert.deepEqual(events, ['idle', 'active']);
});
