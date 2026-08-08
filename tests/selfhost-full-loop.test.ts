/**
 * selfhost-full-loop — PROOF that the core trust-decision loop
 *   HAL VERIFY  →  RepID SCORE  →  DUAL-AUTH GATE
 * runs DATA-LOCAL with ZERO content egress in LOCAL_MODE + ONLY_ATTESTATIONS_LEAVE.
 *
 * This stacks on #380 (data-local boot) and #381 (the SCORE path proven local). It
 * adds the two missing legs — the HAL VERIFY call and the GATE decision — and proves
 * the whole loop:
 *   (a) a decision is produced (HAL verdict → gate ALLOW/REFUSE),
 *   (b) the score event + repid change persist to the LOCAL store,
 *   (c) ZERO content egress — a global.fetch tripwire throws on ANY non-local host and
 *       is never hit by a prompt/response/embedding body. The ONLY fetches are to a
 *       LOCAL mock inference server (LOCAL_LLM_BASE_URL), proving the verify path's
 *       prompt egress stayed on the box.
 *
 * The boundary must BITE, not just be wired: a companion negative test attempts a
 * CLOUD embedding under the boundary and asserts it is REFUSED (the #380 embedding leak).
 *
 * SYNTHETIC ONLY: the agent id is a synthetic UUIDv4 (00000000-…-0002), never a live
 * agent or a real row (the #376 fence).
 *
 * Env is set BEFORE requiring the modules because src/config.ts, src/db.ts, the engine
 * and the HAL builders each read env at load/call time.
 */

import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isLocalHost } from '../src/selfhost/egress-guard';

const SYNTH_AGENT_ID = '00000000-0000-4000-8000-000000000002';

/** A LOCAL openai-compat mock: /chat/completions → a TRUE fact-check verdict; /embeddings → a vector. */
function startLocalInferenceServer(): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        hits.push(req.url ?? '');
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').includes('embeddings')) {
          res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
          return;
        }
        // chat/completions — return the compact fact-check JSON the parser expects.
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"TRUE","confidence":95,"note":"synthetic"}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, hits });
    });
  });
}

describe('LOCAL_MODE: full verify→score→gate loop, zero content egress', () => {
  let tmpDir: string;
  let dbPath: string;
  let server: Server;
  let serverHits: string[];
  let fetchCalls: string[];
  let realFetch: typeof global.fetch;
  let store: any;
  let updateRepId: (input: any) => Promise<any>;
  let halService: any;
  let evaluateGate: (input: any) => any;

  beforeAll(async () => {
    const local = await startLocalInferenceServer();
    server = local.server;
    serverHits = local.hits;
    const base = `http://127.0.0.1:${local.port}/v1`;

    // 1 — env BEFORE module load.
    process.env.LOCAL_MODE = 'true';
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.LOCAL_LLM_BASE_URL = base;
    process.env.SELF_REPORT_EVIDENCE_MODE = 'off'; // clean +25 CODE_CONTRIBUTION (see #381 test)
    // Two API keys present so buildFactCheckProviders assembles a 2-family quorum
    // (groq=llama + deepseek). The endpoints are redirected to the LOCAL base.
    process.env.GROQ_API_KEY = 'dummy-local';
    process.env.DEEPSEEK_API_KEY = 'dummy-local';
    // Keep the quorum to exactly these two families: groq (always-on) + deepseek
    // (explicitly enabled). cerebras off; autobackfill off so no other family sneaks in.
    process.env.HAL_S2_ENABLE_CEREBRAS = 'false';
    process.env.HAL_S2_ENABLE_DEEPSEEK = 'true';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    delete process.env.HAL_DECISION_MODE; // default score mode
    delete process.env.HAL_RETRIEVAL_ENABLED;
    delete process.env.REDIS_URL; // provider-health / semantic-cache become no-ops
    delete process.env.DATABASE_URL; // no direct-pg socket
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_KEY;

    tmpDir = mkdtempSync(join(tmpdir(), 'repid-full-loop-'));
    dbPath = join(tmpDir, 'repid.db');
    process.env.LOCAL_STORE_PATH = dbPath;

    // 2 — egress tripwire. Any fetch to a non-local host THROWS; a local one passes
    // through to realFetch (so the mock server is actually hit). Every call recorded.
    realFetch = global.fetch;
    fetchCalls = [];
    (global as any).fetch = jest.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      fetchCalls.push(url);
      if (!isLocalHost(url)) {
        throw new Error(`EGRESS VIOLATION: loop attempted fetch to non-local host ${url}`);
      }
      return (realFetch as any)(input, init);
    });

    jest.resetModules();
    ({ db: store } = require('../src/db'));
    ({ updateRepId } = require('../src/engine/repid-update'));
    ({ halService } = require('../src/hal/service'));
    ({ evaluateGate } = require('../src/services/dual-auth-gate'));
  });

  afterAll(async () => {
    (global as any).fetch = realFetch;
    try { store?.close?.(); } catch { /* ignore */ }
    await new Promise<void>((r) => server.close(() => r()));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves db to the LOCAL store adapter (not supabase-js)', () => {
    expect(store.__localStore).toBe(true);
    expect(store.__backend).toMatch(/sqlite|file/);
  });

  it('runs verify→score→gate locally, persists the score, and never egresses content', async () => {
    // Seed a SYNTHETIC agent through the same adapter the engine uses.
    await store.from('repid_agents').insert({
      id: SYNTH_AGENT_ID,
      agent_name: 'SYNTHETIC-FULL-LOOP',
      current_repid: 300,
      tier: 'PROBATIONARY',
      activity_30d: 0,
      constitution: {},
    });

    // ── LEG 1: HAL VERIFY (the real fact-check quorum, pointed at the LOCAL server) ──
    const claim = 'The synthetic test agent published documentation for the self-host loop.';
    const verify = await halService.evaluate({ text: claim, strictness: 2 });

    // A real cross-LLM verdict was produced from the LOCAL quorum (NOT the degraded
    // extractor fallback) — proof the verify path ran data-local end to end.
    expect(verify.mode).toBe('fact-check');
    expect(verify.signals.providers_used).toBe(2);
    expect(['clean', 'flagged', 'vetoed', 'abstain']).toContain(verify.decision);
    expect(verify.decision).toBe('clean'); // two confident-TRUE families

    // Map the HAL decision onto the gate's verdict vocabulary.
    const halVerdict: 'PASS' | 'FLAG' | 'VETO' =
      verify.decision === 'vetoed' ? 'VETO' : verify.decision === 'clean' ? 'PASS' : 'FLAG';
    expect(halVerdict).toBe('PASS');

    // ── LEG 2: RepID SCORE (the real engine, LOCAL store) ──
    const scoreResult = await updateRepId({ agentId: SYNTH_AGENT_ID, eventType: 'CODE_CONTRIBUTION' });
    expect(scoreResult.delta).toBe(25);

    // (b) score event + repid change persisted to the LOCAL store.
    const events = (
      await store.from('repid_score_events').select('*').eq('agent_id', SYNTH_AGENT_ID)
    ).data;
    const contribRow = events.find((e: any) => e.event_type === 'CODE_CONTRIBUTION');
    expect(contribRow).toBeDefined();
    expect(contribRow.repid_before).toBe(300);
    const after = (
      await store.from('repid_agents').select('*').eq('id', SYNTH_AGENT_ID).single()
    ).data;
    expect(after.current_repid).not.toBe(300);
    expect(after.current_repid).toBe(scoreResult.repIdAfter);

    // ── LEG 3: DUAL-AUTH GATE (pure decision over the proven score + HAL verdict) ──
    const standardsHash = 'synthetic-standards-hash';
    const gate = evaluateGate({
      agentId: SYNTH_AGENT_ID,
      proofVerified: true,
      proofStatement: {
        agent_id: SYNTH_AGENT_ID,
        repid_score: after.current_repid,
        threshold: 200,
        user_standards_hash: standardsHash,
      },
      boundStandardsHash: standardsHash,
      requiredThreshold: 200,
      halVerdict,
      proofAgeSeconds: 5,
    });

    // (a) a decision is produced — both authorities satisfied + HAL PASS → ALLOW.
    expect(gate.decision).toBe('ALLOW');
    expect(gate.authorities).toEqual({ agent: true, human: true });

    // A VETO would fail-close the SAME inputs — proving HAL is load-bearing in the gate.
    const vetoed = evaluateGate({
      agentId: SYNTH_AGENT_ID,
      proofVerified: true,
      proofStatement: {
        agent_id: SYNTH_AGENT_ID,
        repid_score: after.current_repid,
        threshold: 200,
        user_standards_hash: standardsHash,
      },
      boundStandardsHash: standardsHash,
      requiredThreshold: 200,
      halVerdict: 'VETO',
      proofAgeSeconds: 5,
    });
    expect(vetoed.decision).toBe('REFUSE');
    expect(vetoed.reasons).toContain('hal_vetoed');

    // (c) ZERO content egress. The verify path DID fetch (proving it ran), and EVERY
    // fetch was to the local box; no non-local host was ever contacted.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
    expect(fetchCalls.every((u) => isLocalHost(u))).toBe(true);
    expect(serverHits.filter((u) => u.includes('chat/completions')).length).toBeGreaterThanOrEqual(2);
  });

  it('persisted the verify path write (llm_call_log) to the LOCAL store, not a hosted DB', async () => {
    // logLlmCall is fire-and-forget; let its microtasks flush.
    await new Promise((r) => setTimeout(r, 50));
    const rows = (await store.from('llm_call_log').select('*')).data;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(2); // one row per provider call, written LOCALLY
  });
});

describe('boundary BITES: a cloud embedding under ONLY_ATTESTATIONS_LEAVE is refused', () => {
  const prev = process.env.ONLY_ATTESTATIONS_LEAVE;
  let OpenAIEmbeddingClient: any;
  let EgressBoundaryError: any;

  beforeAll(() => {
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    jest.resetModules();
    ({ OpenAIEmbeddingClient } = require('../src/hal/lib/cross-llm/embedding-client'));
    ({ EgressBoundaryError } = require('../src/selfhost/egress-guard'));
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.ONLY_ATTESTATIONS_LEAVE;
    else process.env.ONLY_ATTESTATIONS_LEAVE = prev;
  });

  it('REFUSES a content-bearing embedding to a CLOUD host (api.openai.com)', async () => {
    const client = new OpenAIEmbeddingClient('https://api.openai.com/v1/embeddings', 'sk-dummy');
    await expect(client.embedMany(['secret answer text'])).rejects.toBeInstanceOf(EgressBoundaryError);
  });

  it('PERMITS a content-bearing embedding to a LOCAL host (the assertion does not throw)', () => {
    // A local endpoint is allowed at the boundary — construct + assert the guard passes.
    // (No fetch executed here; we only prove the boundary lets a LOCAL embedder through.)
    const { assertPromptEgressAllowed } = require('../src/selfhost/egress-guard');
    expect(() =>
      assertPromptEgressAllowed('http://localhost:11434/v1/embeddings', 'embedding', true),
    ).not.toThrow();
  });
});
