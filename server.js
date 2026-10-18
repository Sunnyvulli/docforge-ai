'use strict';
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const path = require('node:path');
const { createStore } = require('./store');

const DOC_COSTS = Object.freeze({ resume: 3, 'cover-letter': 2, contract: 5, invoice: 2, sop: 4, 'business-letter': 2 });
const PACKS = Object.freeze({ starter: 5, value: 15, pro: 40 });

function createApp(options = {}) {
  const env = options.env || process.env;
  const app = express();
  const store = options.store || createStore(env.CREDIT_DATABASE);
  const freeCredits = Number(env.FREE_CREDITS ?? 3);
  if (!Number.isSafeInteger(freeCredits) || freeCredits < 0 || freeCredits > 100) throw new Error('FREE_CREDITS must be an integer 0..100');
  if (env.VERCEL) throw new Error('This SQLite edition requires a persistent single-host volume; serverless deployment is unsupported');
  const paymentsEnabled = env.ENABLE_PAYMENTS === 'true';
  if (paymentsEnabled && (!env.STRIPE_SECRET_KEY?.startsWith('sk_test_') || !env.STRIPE_WEBHOOK_SECRET)) {
    throw new Error('Only explicitly configured Stripe test-mode payments are supported by this audited prototype');
  }
  const stripe = options.stripe || (paymentsEnabled ? new Stripe(env.STRIPE_SECRET_KEY) : null);
  const anthropic = options.anthropic || (env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null);
  const model = env.ANTHROPIC_MODEL;
  const origin = env.APP_URL || 'http://localhost:3000';
  const appURL = new URL(origin);
  if (!['http:', 'https:'].includes(appURL.protocol) || appURL.username || appURL.password || appURL.search || appURL.hash || appURL.pathname !== '/') throw new Error('APP_URL must be an HTTP(S) origin');
  if (env.NODE_ENV === 'production' && appURL.protocol !== 'https:') throw new Error('Production APP_URL must use HTTPS');
  app.disable('x-powered-by');
  // Trust no forwarded client IPs by default. Set a precise proxy topology in a deployment-specific fork.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && req.headers.origin !== appURL.origin) return res.status(403).json({ error: 'Origin not allowed' });
    next();
  });
  app.use('/webhook', express.raw({ type: 'application/json', limit: '128kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, 'public')));
  const limiter = (max, windowMs) => rateLimit({ max, windowMs, standardHeaders: true, legacyHeaders: false });
  const sessionLimiter = limiter(10, 60 * 60 * 1000);
  const generateLimiter = limiter(30, 15 * 60 * 1000);
  const checkoutLimiter = limiter(10, 15 * 60 * 1000);
  const authenticate = (req, res, next) => {
    const token = req.headers['x-session-id'];
    const session = store.get(token);
    if (!session) return res.status(401).json({ error: 'Create or restore a valid session first' });
    if (req.body?.sessionId && req.body.sessionId !== token) return res.status(400).json({ error: 'Session mismatch' });
    req.sessionToken = token;
    next();
  };
  app.get('/api/session', (req, res, next) => {
    const token = req.headers['x-session-id'];
    const existing = store.get(token);
    if (existing) return res.json({ sessionId: token, credits: existing.credits, paymentsEnabled, generationEnabled: Boolean(anthropic && model) });
    if (token) return res.status(401).json({ error: 'Unknown session' });
    next();
  }, sessionLimiter, (req, res) => {
    res.json({ ...store.create(freeCredits), paymentsEnabled, generationEnabled: Boolean(anthropic && model) });
  });
  app.get('/api/credits', authenticate, (req, res) => res.json(store.get(req.sessionToken)));
  app.post('/api/generate', generateLimiter, authenticate, async (req, res) => {
    if (!anthropic || !model) return res.status(503).json({ error: 'Generation is not configured on this server' });
    const { docType, fields, tone = 'Professional', length = 'Standard (1-2 pages)' } = req.body;
    if (!Object.hasOwn(DOC_COSTS, docType) || !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        !Object.keys(fields).length || Object.keys(fields).length > 30 ||
        !Object.entries(fields).every(([k, v]) => k.length <= 100 && typeof v === 'string' && v.length <= 6000) ||
        !Object.values(fields).some(v => v.trim()) || typeof tone !== 'string' || tone.length > 100 ||
        typeof length !== 'string' || length.length > 100) return res.status(400).json({ error: 'Invalid document fields' });
    const reservation = store.reserve(req.sessionToken, DOC_COSTS[docType]);
    if (!reservation) return res.status(402).json({ error: 'Insufficient credits', credits: store.get(req.sessionToken).credits });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    let stream;
    let delivered = false;
    const disconnected = () => stream?.abort?.();
    res.on('close', disconnected);
    const timeout = setTimeout(() => stream?.abort?.(), 90000);
    try {
      stream = anthropic.messages.stream({ model, max_tokens: 2000, messages: [{ role: 'user', content: buildPrompt(docType, fields, tone, length) }] });
      stream.on('text', text => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ text })}\n\n`); });
      await stream.finalMessage();
      if (res.destroyed) throw new Error('Client disconnected');
      store.settle(reservation, true);
      delivered = true;
      res.write(`data: ${JSON.stringify({ done: true, credits: store.get(req.sessionToken).credits })}\n\n`);
    } catch (error) {
      if (!delivered) store.settle(reservation, false);
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ error: 'Generation failed; reserved credits refunded.' })}\n\n`);
    } finally {
      clearTimeout(timeout);res.off('close', disconnected);
      if (!res.destroyed) res.end();
    }
  });
  app.post('/api/checkout', checkoutLimiter, authenticate, async (req, res) => {
    if (!paymentsEnabled) return res.status(503).json({ error: 'Purchases disabled; this is an audited prototype' });
    const { pack } = req.body;
    if (!Object.hasOwn(PACKS, pack)) return res.status(400).json({ error: 'Invalid pack' });
    const price = env[`STRIPE_PRICE_${pack.toUpperCase()}`];
    if (!price?.startsWith('price_')) return res.status(503).json({ error: 'Test price not configured' });
    try {
      const checkout = await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'],
        line_items: [{ price, quantity: 1 }], success_url: `${appURL.origin}/?payment=success`, cancel_url: `${appURL.origin}/?payment=cancelled` });
      store.recordCheckout(checkout.id, req.sessionToken, PACKS[pack]);
      res.json({ url: checkout.url });
    } catch (error) { res.status(503).json({ error: 'Test checkout setup failed' }); }
  });
  app.post('/webhook', (req, res) => {
    if (!paymentsEnabled) return res.status(503).json({ error: 'Payments disabled' });
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET); }
    catch (error) { return res.status(400).json({ error: 'Invalid webhook signature' }); }
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const checkout = event.data?.object;
      if (checkout?.payment_status !== 'paid') return res.json({ received: true, fulfilled: false });
      try { return res.json({ received: true, fulfilled: store.fulfill(event.id, checkout.id) }); }
      catch (error) { return res.status(503).json({ error: 'Checkout not ready; retry event' }); }
    }
    return res.json({ received: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid request' });
  });
  app.locals.creditStore = store;
  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`DocForge prototype listening on port ${port}`));
}
function buildPrompt(docType, fields, tone = 'Professional', length = 'Standard (1-2 pages)') {
  const docNames = {
    'resume': 'Resume / CV',
    'cover-letter': 'Cover Letter',
    'contract': 'Contract / Agreement',
    'invoice': 'Invoice',
    'sop': 'Standard Operating Procedure',
    'business-letter': 'Business Letter',
  };

  const fieldText = Object.entries(fields)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return `You are an expert professional document writer with 20 years of experience.

Write a complete, polished ${docNames[docType]} with the following specifications:
- Tone: ${tone}
- Length: ${length}

Document details provided by the user:
${fieldText}

Instructions:
- Write the COMPLETE document, fully formatted and ready to use
- Use proper professional structure and formatting for this document type
- Include ALL standard sections expected in this type of document
- For contracts: include standard legal clauses (jurisdiction, termination, liability, etc.)
- For resumes: use strong action verbs; never invent employers, degrees, certifications, metrics, or achievements. Use only supplied facts.
- For invoices: clearly show line items, subtotals, tax line (if applicable), and total
- For SOPs: use numbered steps, assign responsibilities, include purpose and scope sections
- Output ONLY the document itself — no commentary, no preamble, no markdown code fences`;
}

module.exports = { createApp, buildPrompt };
