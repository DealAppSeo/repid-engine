#!/usr/bin/env node
/**
 * Adversarial-gate harness — boots the REAL `POST /api/v1/hal/evaluate` router on an
 * ephemeral loopback port so promptfoo can drive it over HTTP.
 *
 * It mounts `src/routes/hal-evaluate.ts` itself (via ts-node), NOT a re-implementation:
 * if the route's request handling, its `scanForInjection` screen, or its response envelope
 * changes, this harness serves the changed behaviour and the gate sees it.
 *
 * WHAT THIS HARNESS DOES **NOT** EXERCISE — say NOT_CHECKED about these, do not infer them
 * from a green gate:
 *   - the `src/index.ts` middleware chain (helmet, cors, the SQL-keyword body sanitizer,
 *     authMiddleware, rateLimitMiddleware, versioningMiddleware). The route is mounted bare,
 *     which matches the mounting the route's own header comment prescribes for this path
 *     (sanitizer-bypassed, unauthenticated) — but the chain itself is untested here.
 *   - anything about the deployed service. This is localhost only.
 *
 * DETERMINISM / BLAST-RADIUS FENCES (all deliberate, all forced rather than defaulted):
 *   - SUPABASE_URL is forced to a non-routable loopback. A successful fresh evaluation fires
 *     `recordPublicFactCheck()`, which INSERTs one row into the public fact-check counter.
 *     Adversarial probe traffic must never inflate a real public counter, so the write is
 *     pointed at nothing and the route swallows the failure (it is fire-and-forget by design).
 *   - REDIS_URL is deleted. The HAL cache returns a previous verdict for the same
 *     (text, strictness) inside its TTL, which would make `mode` a stale value from an
 *     earlier run instead of a fresh measurement. No Redis → guaranteed cache miss → every
 *     probe is evaluated fresh.
 *
 * Emits one line of JSON on stdout once listening, so the runner never has to poll or sleep:
 *   {"ready":true,"port":<n>,"url":"http://127.0.0.1:<n>/api/v1/hal/evaluate","quorum_providers":<n>}
 *
 * `quorum_providers` is the count returned by the engine's own `buildFactCheckProviders()` —
 * asked of the code, not guessed from a list of env var names (such a list has already rotted
 * once in this codebase). It is a COUNT only: no provider names, no key material.
 */
'use strict';

const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// --- fences (see header) ---------------------------------------------------------------
process.env.SUPABASE_URL = 'http://127.0.0.1:1/harness-no-write';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'harness-dummy';
delete process.env.REDIS_URL;
// Never let the harness reach a self-hosted local store either — same blast-radius reason.
delete process.env.LOCAL_MODE;

require(path.join(REPO_ROOT, 'node_modules', 'ts-node')).register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs' },
  // The repo's tsconfig excludes nothing under src/, but transpile-only keeps boot fast and
  // means a pre-existing type error elsewhere cannot masquerade as a gate failure. Type errors
  // are `npx tsc --noEmit`'s job, and that already runs in CI.
});

const express = require('express');
const halEvaluateRouter = require(path.join(REPO_ROOT, 'src', 'routes', 'hal-evaluate.ts')).default;
const { buildFactCheckProviders } = require(path.join(REPO_ROOT, 'src', 'hal', 'fact-check.ts'));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/hal', halEvaluateRouter);

const port = Number(process.env.HAL_GATE_PORT || 0);
const server = app.listen(port, '127.0.0.1', () => {
  let quorumProviders = 0;
  try {
    quorumProviders = buildFactCheckProviders().length;
  } catch (e) {
    // A throw here is itself a finding the runner must see, not swallow.
    process.stdout.write(
      JSON.stringify({ ready: false, error: 'buildFactCheckProviders threw', detail: String(e && e.message) }) + '\n',
    );
    process.exit(1);
  }
  const actual = server.address().port;
  process.stdout.write(
    JSON.stringify({
      ready: true,
      port: actual,
      url: `http://127.0.0.1:${actual}/api/v1/hal/evaluate`,
      quorum_providers: quorumProviders,
    }) + '\n',
  );
});

server.on('error', (e) => {
  process.stdout.write(JSON.stringify({ ready: false, error: 'listen failed', detail: String(e && e.message) }) + '\n');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // The route's fire-and-forget writes can hold the loop briefly; do not wait on them.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
