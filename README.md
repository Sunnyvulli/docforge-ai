# DocForge AI

A local document-generation prototype with streaming output, durable credit accounting, and optional **Stripe test-mode** checkout. It is not a validated commercial service. No revenue, deployment, or document-accuracy outcome is claimed.

## Run

Use Node.js 24. A compatible provider key and an available model identifier are needed only for real generation. Unit and HTTP integration tests use local stubs; they make no paid API calls.

```bash
npm ci
cp .env.example .env
npm test
npm start
```

Open http://localhost:3000. The app can start without provider credentials; generation returns a clear unavailable response until configured. Model identifiers are explicit configuration rather than a hard-coded claim of current availability.

## What works

- Server-issued random bearer sessions; unknown client identifiers cannot create credited accounts.
- SQLite-backed sessions, credit reservations, refunds, pending checkouts, and payment-event deduplication.
- Credits reserved atomically before generation, preventing overlapping requests from overspending.
- Failed streaming requests refund their reservation once; successful requests consume it once.
- Signed webhooks fulfil only paid, server-recorded test checkouts. Duplicate event IDs and separate events for the same checkout cannot double-credit a purchase.
- Incremental browser event parsing preserves messages split across network chunks and distinguishes failure from completion.
- Body/schema checks, creation/generation/checkout rate limits, same-origin policy, and bounded provider streams.

`public/index.html` retains the existing user interface. Displayed package prices are illustrative; configured Stripe test prices determine test checkout amounts. Generated employment claims, legal clauses, invoices, and other content require user verification. The prompt requests that unsupported qualifications and outcomes not be invented.

## Operating boundaries

This edition uses Node's SQLite interface and requires a **persistent single host**. It refuses Vercel/serverless startup; the old serverless deployment instructions were incompatible with durable local credit storage. Do not put the database on a public web root. Back it up, restrict host access, and keep session bearer tokens private. Losing the browser token loses self-service access; account recovery is not implemented.

Payments default off and live Stripe keys are rejected. Real customer billing requires authenticated accounts/recovery, payment/refund reconciliation, operational monitoring, privacy and retention decisions, backup restoration testing, and deployment review. No live payment or external model request was executed during the audit.

If a process crashes mid-generation, a pending reservation remains recorded. Do not automatically refund it on every startup: a second worker could still be serving it. An operator must reconcile pending records against request/provider logs before settling them. This unresolved crash-recovery workflow is documented rather than described as production-ready.

Rate limits apply to the direct client IP. Forwarded IP headers are not trusted; behind a proxy, configure the exact trusted topology and a shared limiter before public deployment. Anonymous free-credit issuance is not abuse-proof or a replacement for account controls.

## Tests and maintenance

`npm test` exercises persistent accounting, duplicate/unpaid webhooks, concurrent reservations, invalid sessions/fields, failure refunds, and split SSE frames. `npm run check` checks JavaScript syntax. The lockfile records dependency resolution; run `npm audit` and review dependency changes before deployment. A clean package audit is not proof that application security is complete.

## Sources and provenance

The audit extends the existing owner's application. New accounting, validation, and test code was developed with OpenAI Codex assistance. Primary implementation references:

- Node.js SQLite: https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html
- Stripe webhook delivery/signatures: https://docs.stripe.com/webhooks
- Checkout fulfilment and duplicate handling: https://docs.stripe.com/payments/checkout/fulfill-orders

The existing repository described its code as MIT-licensed. Third-party package licenses remain their own.
