/**
 * SELF-HOST / DATA-LOCAL entrypoint (skeleton).
 *
 * This is the minimal, data-local boot of repid-engine. It is DELIBERATELY not
 * the full `src/index.ts`: that entrypoint starts ~20 background workers and
 * cron loops that read/write the hosted Supabase every few seconds. Those
 * workers are NOT yet backed by a local store, so booting them in LOCAL_MODE
 * would spin errors against a loopback DB — dishonest as a "self-host" claim.
 *
 * What THIS entrypoint proves today:
 *   - the process boots with NO hosted Supabase (LOCAL_MODE, no throw at
 *     config.ts),
 *   - it reports the data-locality boundary it is running under,
 *   - it exposes the core HTTP surface (/health, /selfhost/status).
 *
 * What is STILL hosted-only (STUB for self-host): the score-mutation pipeline
 * and every worker in src/index.ts, all of which talk to Supabase over the
 * network. Making those run against SQLite/local-Postgres is the next slice;
 * see SELFHOST.md.
 *
 * Run: LOCAL_MODE=true node dist/selfhost.js   (or ts-node src/selfhost.ts)
 */

import express from 'express';
import {
  config,
  LOCAL_MODE,
  ONLY_ATTESTATIONS_LEAVE,
  LOCAL_LLM_BASE_URL,
} from './config';
import { classifyEgress } from './selfhost/egress-guard';

const app = express();
app.use(express.json({ limit: '1mb' }));

const STARTED_AT = new Date().toISOString();

interface SelfHostStatus {
  service: 'repid-engine';
  mode: 'self-host';
  version: string;
  started_at: string;
  local_mode: boolean;
  data_store: {
    supabase_url: string;
    hosted: boolean;
  };
  egress_boundary: {
    only_attestations_leave: boolean;
    prompt_egress_to_cloud: 'blocked' | 'allowed';
    description: string;
  };
  llm: {
    local_base_url: string | null;
    quorum_target: 'local' | 'cloud';
  };
  boots_today: string[];
  stub_for_selfhost: string[];
}

function buildStatus(): SelfHostStatus {
  const hostedDb = !!process.env.SUPABASE_URL;
  const localBase = LOCAL_LLM_BASE_URL || null;
  // Illustrative classification of a cloud LLM egress under the current boundary.
  const sampleCloudLlm = classifyEgress(
    'https://api.groq.com/openai/v1/chat/completions',
    'prompt',
    ONLY_ATTESTATIONS_LEAVE,
  );
  return {
    service: 'repid-engine',
    mode: 'self-host',
    version: config.version,
    started_at: STARTED_AT,
    local_mode: LOCAL_MODE,
    data_store: {
      // In LOCAL_MODE with no SUPABASE_URL this is the loopback default — no
      // hosted DB. Never prints a key.
      supabase_url: config.supabaseUrl,
      hosted: hostedDb,
    },
    egress_boundary: {
      only_attestations_leave: ONLY_ATTESTATIONS_LEAVE,
      prompt_egress_to_cloud: sampleCloudLlm.allowed ? 'allowed' : 'blocked',
      description:
        'When ONLY_ATTESTATIONS_LEAVE is set, prompt/response text may not egress ' +
        'to a non-local host; proofs / EAS anchors / chain writes still may.',
    },
    llm: {
      local_base_url: localBase,
      quorum_target: localBase ? 'local' : 'cloud',
    },
    boots_today: [
      'core HTTP service (this process)',
      'config load without hosted Supabase (LOCAL_MODE)',
      'data-locality egress boundary (ONLY_ATTESTATIONS_LEAVE)',
      'OpenAI-compatible LLM base-URL override (LOCAL_LLM_BASE_URL)',
    ],
    stub_for_selfhost: [
      'RepID score-mutation pipeline (src/engine/repid-update.ts) — Supabase-backed',
      'all background workers / crons in src/index.ts — Supabase-backed',
      'local persistent store adapter (SQLite/local-Postgres) — not yet built',
    ],
  };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'repid-engine',
    mode: 'self-host',
    local_mode: LOCAL_MODE,
    hosted_db: !!process.env.SUPABASE_URL,
  });
});

app.get('/selfhost/status', (_req, res) => {
  res.json(buildStatus());
});

const port = parseInt(process.env.PORT || '3000', 10);
const IS_TEST = process.env.NODE_ENV === 'test';

if (!IS_TEST) {
  app.listen(port, '0.0.0.0', () => {
    const s = buildStatus();
    // eslint-disable-next-line no-console
    console.log(
      `[selfhost] repid-engine v${s.version} data-local boot on :${port}\n` +
        `  local_mode=${s.local_mode} hosted_db=${s.data_store.hosted}\n` +
        `  only_attestations_leave=${s.egress_boundary.only_attestations_leave} ` +
        `prompt_egress_to_cloud=${s.egress_boundary.prompt_egress_to_cloud}\n` +
        `  llm_quorum_target=${s.llm.quorum_target} local_base_url=${s.llm.local_base_url ?? '(unset)'}`,
    );
  });
}

export { app, buildStatus };
export default app;
