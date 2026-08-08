/**
 * selfhost-local-store — PROOF that a full RepID score event completes LOCALLY
 * with ZERO data egress.
 *
 * This drives the REAL updateRepId() (and its REAL layer dependencies: decay,
 * ecosystem-need, redemption, badges) in LOCAL_MODE, against a temp SQLite/JSON
 * store, and asserts the three things "data stays yours" means for the score path:
 *   (a) a repid_score_events row was written to the LOCAL store,
 *   (b) the agent's current_repid changed,
 *   (c) NO network egress occurred — proven by a global.fetch tripwire that throws
 *       on any non-local host, wired through the ONLY_ATTESTATIONS_LEAVE guard's
 *       isLocalHost(). The score path must never call it.
 *
 * SYNTHETIC ONLY: the agent id is a synthetic UUIDv4 (00000000-…-0001), never a
 * live agent, never a real row (the #376 fence).
 *
 * Env is set BEFORE requiring the modules because src/config.ts, src/db.ts and
 * src/engine/repid-update.ts each read env at module load; jest.resetModules() +
 * require() guarantees they observe LOCAL_MODE.
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isLocalHost } from '../src/selfhost/egress-guard';

const SYNTH_AGENT_ID = '00000000-0000-4000-8000-000000000001';

describe('LOCAL_MODE: a full RepID score event completes locally with zero egress', () => {
  let tmpDir: string;
  let dbPath: string;
  let fetchSpy: jest.Mock;
  let realFetch: typeof global.fetch;
  let store: any; // the local adapter (typed as SupabaseClient at the source)
  let updateRepId: (input: any) => Promise<any>;

  beforeAll(() => {
    // 1 — env BEFORE module load.
    process.env.LOCAL_MODE = 'true';
    // Disable the self-report evidence gate so CODE_CONTRIBUTION applies its clean
    // +25 (default 'enforce' would zero an unproven self-report — a different test).
    process.env.SELF_REPORT_EVIDENCE_MODE = 'off';
    // Engage the data-locality boundary too (defensive; the score path makes no
    // content-bearing egress regardless).
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    // Ensure no hosted DB is even configured.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_KEY;

    tmpDir = mkdtempSync(join(tmpdir(), 'repid-local-store-'));
    dbPath = join(tmpDir, 'repid.db');
    process.env.LOCAL_STORE_PATH = dbPath;

    // 2 — egress tripwire. Any fetch to a non-local host throws; a local one is
    // permitted (the score path should call NEITHER).
    realFetch = global.fetch;
    fetchSpy = jest.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input);
      if (!isLocalHost(url)) {
        throw new Error(`EGRESS VIOLATION: score path attempted fetch to non-local host ${url}`);
      }
      return (realFetch as any)(input, init);
    });
    (global as any).fetch = fetchSpy;

    jest.resetModules();
    // require AFTER env + resetModules so LOCAL_MODE is observed at load.
    ({ db: store } = require('../src/db'));
    ({ updateRepId } = require('../src/engine/repid-update'));
  });

  afterAll(() => {
    (global as any).fetch = realFetch;
    try {
      store?.close?.();
    } catch {
      /* ignore */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolves db to the LOCAL store adapter (not supabase-js)', () => {
    expect(store.__localStore).toBe(true);
    expect(typeof store.__backend).toBe('string');
    // node:sqlite is available on this Node, but either durable backend is honest.
    expect(store.__backend).toMatch(/sqlite|file/);
  });

  it('writes a score-event row + moves current_repid + zero egress', async () => {
    // Seed a SYNTHETIC agent through the SAME adapter the engine uses.
    await store.from('repid_agents').insert({
      id: SYNTH_AGENT_ID,
      agent_name: 'SYNTHETIC-LOCAL',
      current_repid: 200,
      tier: 'PROBATIONARY',
      activity_30d: 0,
      constitution: {},
    });

    const before = (
      await store.from('repid_agents').select('*').eq('id', SYNTH_AGENT_ID).single()
    ).data;
    expect(before.current_repid).toBe(200);

    // THE REAL SCORE PATH.
    const result = await updateRepId({
      agentId: SYNTH_AGENT_ID,
      eventType: 'CODE_CONTRIBUTION',
    });

    // (a) a repid_score_events row landed in the LOCAL store.
    const events = (
      await store.from('repid_score_events').select('*').eq('agent_id', SYNTH_AGENT_ID)
    ).data;
    expect(events.length).toBeGreaterThanOrEqual(1);
    const contribRow = events.find((e: any) => e.event_type === 'CODE_CONTRIBUTION');
    expect(contribRow).toBeDefined();
    expect(contribRow.delta).toBe(25);
    expect(contribRow.repid_before).toBe(200);

    // (b) the agent's current_repid changed, and matches the engine's report.
    const after = (
      await store.from('repid_agents').select('*').eq('id', SYNTH_AGENT_ID).single()
    ).data;
    expect(after.current_repid).not.toBe(200);
    expect(after.current_repid).toBe(result.repIdAfter);
    expect(result.delta).toBe(25);
    // decay (~-3 on DEV params) + delta (+25): net upward from 200.
    expect(result.repIdAfter).toBeGreaterThan(200);

    // (c) ZERO network egress: the tripwire was never called at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('persisted durably to a LOCAL file — a fresh adapter on the same path sees the row', async () => {
    expect(existsSync(dbPath)).toBe(true);
    jest.resetModules();
    const { createLocalStore } = require('../src/selfhost/local-store');
    const reopened = createLocalStore(dbPath);
    try {
      const events = (
        await reopened.from('repid_score_events').select('*').eq('agent_id', SYNTH_AGENT_ID)
      ).data;
      expect(events.some((e: any) => e.event_type === 'CODE_CONTRIBUTION')).toBe(true);
      const agent = (
        await reopened.from('repid_agents').select('*').eq('id', SYNTH_AGENT_ID).single()
      ).data;
      expect(agent.current_repid).toBeGreaterThan(200);
    } finally {
      reopened.close();
    }
  });
});
