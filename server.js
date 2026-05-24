require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── In-memory credit store (swap for a DB in production) ──────────────────
// Key: sessionId, Value: { credits, usedDocs }
const creditStore = new Map();

const FREE_CREDITS = parseInt(process.env.FREE_CREDITS || '3');

function getSession(sessionId) {
  if (!creditStore.has(sessionId)) {
    creditStore.set(sessionId, { credits: FREE_CREDITS, usedDocs: [] });
  }
  return creditStore.get(sessionId);
}

// ── Credit costs per document type ────────────────────────────────────────
const DOC_COSTS = {
  'resume': 3,
  'cover-letter': 2,
  'contract': 5,
  'invoice': 2,
  'sop': 4,
  'business-letter': 2,
};

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' })); // raw for Stripe
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — 30 generate requests per 15 min per IP
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' }
});

// ── GET /api/session ───────────────────────────────────────────────────────
// Returns or creates a session with credit balance
app.get('/api/session', (req, res) => {
  const sessionId = req.headers['x-session-id'] || uuidv4();
  const session = getSession(sessionId);
  res.json({ sessionId, credits: session.credits });
});

// ── POST /api/generate ────────────────────────────────────────────────────
// Streams AI-generated document back to client
app.post('/api/generate', generateLimiter, async (req, res) => {
  const { sessionId, docType, fields, tone, length } = req.body;

  if (!sessionId || !docType || !fields) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const cost = DOC_COSTS[docType];
  if (!cost) return res.status(400).json({ error: 'Invalid document type.' });

  const session = getSession(sessionId);
  if (session.credits < cost) {
    return res.status(402).json({ error: 'Insufficient credits.', credits: session.credits });
  }

  // Build prompt
  const prompt = buildPrompt(docType, fields, tone, length);

  // Set up SSE streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    });

    await stream.finalMessage();

    // Deduct credits only after successful generation
    session.credits -= cost;
    session.usedDocs.push({ docType, timestamp: new Date().toISOString() });

    res.write(`data: ${JSON.stringify({ done: true, credits: session.credits })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.write(`data: ${JSON.stringify({ error: 'Generation failed. Please try again.' })}\n\n`);
    res.end();
  }
});

// ── POST /api/checkout ────────────────────────────────────────────────────
// Creates a Stripe Checkout session
app.post('/api/checkout', async (req, res) => {
  const { pack, sessionId } = req.body;

  const packs = {
    starter: { priceId: process.env.STRIPE_PRICE_STARTER, credits: 5, label: 'Starter — 5 credits' },
    value:   { priceId: process.env.STRIPE_PRICE_VALUE,   credits: 15, label: 'Value — 15 credits' },
    pro:     { priceId: process.env.STRIPE_PRICE_PRO,     credits: 40, label: 'Pro — 40 credits' },
  };

  const selected = packs[pack];
  if (!selected) return res.status(400).json({ error: 'Invalid pack.' });

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{ price: selected.priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/?payment=success&session=${sessionId}&credits=${selected.credits}`,
      cancel_url: `${process.env.APP_URL}/?payment=cancelled`,
      metadata: { sessionId, credits: selected.credits, pack },
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Payment setup failed.' });
  }
});

// ── POST /webhook ──────────────────────────────────────────────────────────
// Stripe webhook — add credits after successful payment
app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { sessionId, credits } = session.metadata;
    if (sessionId && credits) {
      const userSession = getSession(sessionId);
      userSession.credits += parseInt(credits);
      console.log(`Added ${credits} credits to session ${sessionId}`);
    }
  }

  res.json({ received: true });
});

// ── GET /api/credits ──────────────────────────────────────────────────────
app.get('/api/credits', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error: 'No session ID.' });
  const session = getSession(sessionId);
  res.json({ credits: session.credits });
});

// ── Serve index.html for all other routes ────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DocForge running on http://localhost:${PORT}`);
});

// ── Prompt builder ────────────────────────────────────────────────────────
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
- For resumes: use strong action verbs and quantify achievements where possible
- For invoices: clearly show line items, subtotals, tax line (if applicable), and total
- For SOPs: use numbered steps, assign responsibilities, include purpose and scope sections
- Output ONLY the document itself — no commentary, no preamble, no markdown code fences`;
}

module.exports = app;
