'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../store');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('client identifiers cannot create sessions', () => {
  const store = createStore(':memory:');
  assert.equal(store.get('attacker-supplied-id'), undefined);
  assert.equal(store.get('00000000-0000-0000-0000-000000000000'), undefined);
  store.close();
});
test('reservations cannot overspend and refunds settle once', () => {
  const store = createStore(':memory:');
  const { sessionId } = store.create(3);
  const first = store.reserve(sessionId, 3);
  assert.ok(first);assert.equal(store.reserve(sessionId, 3), null);
  assert.equal(store.get(sessionId).credits, 0);
  assert.equal(store.settle(first, false), true);
  assert.equal(store.settle(first, false), false);
  assert.equal(store.get(sessionId).credits, 3);
  store.close();
});
test('separate webhook events for one checkout grant credits once', () => {
  const store = createStore(':memory:');
  const { sessionId } = store.create(3);
  store.recordCheckout('cs_1', sessionId, 5);
  assert.equal(store.fulfill('evt_1', 'cs_1'), true);
  assert.equal(store.fulfill('evt_1', 'cs_1'), false);
  assert.equal(store.fulfill('evt_2', 'cs_1'), false);
  assert.equal(store.get(sessionId).credits, 8);
  store.close();
});
test('unknown checkout rolls back the event so delivery can retry', () => {
  const store = createStore(':memory:');
  const { sessionId } = store.create(0);
  assert.throws(() => store.fulfill('evt_late', 'cs_late'));
  store.recordCheckout('cs_late', sessionId, 5);
  assert.equal(store.fulfill('evt_late', 'cs_late'), true);
  store.close();
});
test('balances and deduplication persist after reopening database', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'docforge-'));
  const file = path.join(dir, 'db.sqlite');
  let store = createStore(file);
  const { sessionId } = store.create(3);
  store.recordCheckout('cs_persist', sessionId, 15);
  store.fulfill('evt_persist', 'cs_persist');store.close();
  store = createStore(file);
  assert.equal(store.get(sessionId).credits, 18);
  assert.equal(store.fulfill('evt_persist', 'cs_persist'), false);
  store.close();rmSync(dir, { recursive: true });
});
