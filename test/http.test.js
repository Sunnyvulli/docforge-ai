'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../server');
const { createStore } = require('../store');

async function fixture(t, extra = {}) {
  const store = createStore(':memory:');
  const env = { APP_URL: 'http://localhost:3000', ANTHROPIC_MODEL: 'test-model', FREE_CREDITS: '3', ...extra.env };
  const anthropic = extra.anthropic || { messages: { stream() {
    const stream = new EventEmitter();
    stream.abort = () => {};
    stream.finalMessage = async () => { stream.emit('text', 'Test document');return {}; };
    return stream;
  } } };
  const app = createApp({ store, env, anthropic, stripe: extra.stripe });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close(); });
  const session = await (await fetch(origin + '/api/session')).json();
  const post = (route, body, headers = {}) => fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': session.sessionId, ...headers }, body: JSON.stringify(body) });
  return { store, origin, session, post };
}

test('generation requires a server-issued session', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/generate', { docType: 'resume', fields: { name: 'A' } }, { 'x-session-id': 'forged' })).status, 401);
});
test('prototype keys and invalid field types are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/generate', { docType: '__proto__', fields: { name: 'A' } })).status, 400);
  assert.equal((await f.post('/api/generate', { docType: 'resume', fields: { name: 123 } })).status, 400);
  assert.equal(f.store.get(f.session.sessionId).credits, 3);
});
test('session mismatch and cross-origin calls are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/generate', { sessionId: 'other', docType: 'resume', fields: { name: 'A' } })).status, 400);
  assert.equal((await f.post('/api/generate', {}, { origin: 'https://attacker.invalid' })).status, 403);
});
test('successful generation consumes credits and returns a terminal SSE event', async t => {
  const f = await fixture(t);
  const res = await f.post('/api/generate', { docType: 'resume', fields: { name: 'A' } });
  const text = await res.text();
  assert.equal(res.status, 200);assert.match(text, /Test document/);assert.match(text, /"done":true/);
  assert.equal(f.store.get(f.session.sessionId).credits, 0);
});
test('failed generation refunds the reservation', async t => {
  const anthropic = { messages: { stream() { throw new Error('Simulated upstream failure'); } } };
  const f = await fixture(t, { anthropic });
  const res = await f.post('/api/generate', { docType: 'resume', fields: { name: 'A' } });
  assert.match(await res.text(), /refunded/);
  assert.equal(f.store.get(f.session.sessionId).credits, 3);
});
test('overlapping generation requests cannot spend the same balance', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const anthropic = { messages: { stream() { const stream = new EventEmitter();stream.abort = () => {};stream.finalMessage = () => gate;return stream; } } };
  const f = await fixture(t, { anthropic });
  const first = await f.post('/api/generate', { docType: 'resume', fields: { name: 'A' } });
  const second = await f.post('/api/generate', { docType: 'resume', fields: { name: 'B' } });
  assert.equal(second.status, 402);release({});await first.text();
  assert.equal(f.store.get(f.session.sessionId).credits, 0);
});
test('payments are disabled by default', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/checkout', { pack: 'starter' })).status, 503);
});
test('unpaid and duplicate webhooks do not inflate balances', async t => {
  let event;
  const stripe = { checkout: { sessions: { create: async () => ({ id: 'cs_test', url: 'https://checkout.stripe.com/test' }) } }, webhooks: { constructEvent: () => event } };
  const f = await fixture(t, { stripe, env: { ENABLE_PAYMENTS: 'true', STRIPE_SECRET_KEY: 'sk_test_stub', STRIPE_WEBHOOK_SECRET: 'stub', STRIPE_PRICE_STARTER: 'price_stub' } });
  assert.equal((await f.post('/api/checkout', { pack: 'starter' })).status, 200);
  event = { id: 'evt_unpaid', type: 'checkout.session.completed', data: { object: { id: 'cs_test', payment_status: 'unpaid', metadata: { credits: '999999' } } } };
  await f.post('/webhook', {});assert.equal(f.store.get(f.session.sessionId).credits, 3);
  event = { ...event, id: 'evt_paid', data: { object: { id: 'cs_test', payment_status: 'paid', metadata: { credits: '999999' } } } };
  await f.post('/webhook', {});await f.post('/webhook', {});
  event.id = 'evt_second';await f.post('/webhook', {});
  assert.equal(f.store.get(f.session.sessionId).credits, 8);
});
test('invalid webhook signatures cannot fulfil checkout', async t => {
  const stripe = { webhooks: { constructEvent: () => { throw new Error('bad signature'); } } };
  const f = await fixture(t, { stripe, env: { ENABLE_PAYMENTS: 'true', STRIPE_SECRET_KEY: 'sk_test_stub', STRIPE_WEBHOOK_SECRET: 'stub' } });
  assert.equal((await f.post('/webhook', {})).status, 400);
});
