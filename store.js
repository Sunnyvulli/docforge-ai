'use strict';
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createStore(filename = path.join(__dirname, '.data', 'credits.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, credits INTEGER NOT NULL CHECK(credits >= 0), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, credits INTEGER NOT NULL CHECK(credits > 0), fulfilled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, credits INTEGER NOT NULL, status TEXT NOT NULL
    );`);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const session = token => typeof token === 'string' && /^[a-f0-9-]{36}$/.test(token)
    ? db.prepare('SELECT credits FROM sessions WHERE token_hash=?').get(tokenHash(token)) : undefined;
  return {
    create(credits) {
      if (!Number.isSafeInteger(credits) || credits < 0 || credits > 100) throw new Error('Invalid free-credit policy');
      const token = randomUUID();
      db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash(token), credits, new Date().toISOString());
      return { sessionId: token, credits };
    },
    get: session,
    reserve(token, credits) {
      if (!Number.isSafeInteger(credits) || credits <= 0) throw new Error('Invalid reservation');
      return transaction(() => {
        if (!session(token)) return null;
        const change = db.prepare('UPDATE sessions SET credits=credits-? WHERE token_hash=? AND credits>=?').run(credits, tokenHash(token), credits);
        if (!change.changes) return null;
        const id = randomUUID();
        db.prepare('INSERT INTO reservations VALUES (?,?,?,?)').run(id, tokenHash(token), credits, 'pending');
        return id;
      });
    },
    settle(id, succeeded) {
      return transaction(() => {
        const reservation = db.prepare("SELECT * FROM reservations WHERE id=? AND status='pending'").get(id);
        if (!reservation) return false;
        if (!succeeded) db.prepare('UPDATE sessions SET credits=credits+? WHERE token_hash=?').run(reservation.credits, reservation.token_hash);
        db.prepare('UPDATE reservations SET status=? WHERE id=?').run(succeeded ? 'consumed' : 'refunded', id);
        return true;
      });
    },
    recordCheckout(id, token, credits) {
      if (!session(token) || !Number.isSafeInteger(credits) || credits <= 0) throw new Error('Invalid checkout');
      db.prepare('INSERT INTO checkouts(id, token_hash, credits) VALUES (?,?,?)').run(id, tokenHash(token), credits);
    },
    fulfill(eventId, checkoutId) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM payment_events WHERE id=?').get(eventId)) return false;
        const checkout = db.prepare('SELECT * FROM checkouts WHERE id=?').get(checkoutId);
        if (!checkout) throw new Error('Unknown checkout; retry after checkout persistence');
        db.prepare('INSERT INTO payment_events VALUES (?,?)').run(eventId, checkoutId);
        if (checkout.fulfilled) return false;
        db.prepare('UPDATE sessions SET credits=credits+? WHERE token_hash=?').run(checkout.credits, checkout.token_hash);
        db.prepare('UPDATE checkouts SET fulfilled=1 WHERE id=?').run(checkoutId);
        return true;
      });
    },
    close() { db.close(); }
  };
}
module.exports = { createStore };
