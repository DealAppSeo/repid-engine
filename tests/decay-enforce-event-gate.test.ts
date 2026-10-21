/**
 * decay-enforce-event-gate — what REPID_DECAY_MODE=enforce does on the live event path.
 *
 * Measured 2026-10-20 (flag experiments, E1), each of these was false on main:
 *   1. decay compounded per EVENT: every applyValidationEvent re-decayed the base, so seven
 *      events within seconds took ~200 points from one agent;
 *   2. a zero-delta event decayed the agent, so a simulated contract — guaranteed to move no
 *      RepID — moved it;
 *   3. the input was repid_agents.activity_30d, which this pipeline never updates: in production
 *      actively trading agents read 0 and near-idle ones read in the hundreds.
 *
 * Driven through the REAL applyValidationEvent on the LOCAL_MODE store (synthetic UUIDs only).
 * Assertions are relative, never tuned values: the decay constants are not in this repo.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DAY = 24 * 60 * 60 * 1000;
let n = 0x700;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`;

describe('REPID_DECAY_MODE=enforce on the event path', () => {
  let tmpDir: string;
  let db: any;
  let applyValidationEvent: (id: string, type: any, delta: number, meta?: Record<string, any>) => Promise<any>;
  const saved = { mode: process.env.REPID_DECAY_MODE };

  beforeAll(() => {
    process.env.LOCAL_MODE = 'true';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.ZKP_SERVICE_URL;
    tmpDir = mkdtempSync(join(tmpdir(), 'decay-gate-'));
    process.env.LOCAL_STORE_PATH = join(tmpDir, 'repid.db');
    jest.resetModules();
    ({ db } = require('../src/db'));
    ({ applyValidationEvent } = require('../src/scoring/pipeline'));
  });

  beforeEach(() => {
    process.env.REPID_DECAY_MODE = 'enforce'; // read per call, so a test can switch it
  });

  afterAll(() => {
    if (saved.mode === undefined) delete process.env.REPID_DECAY_MODE;
    else process.env.REPID_DECAY_MODE = saved.mode;
    try { db?.close?.(); } catch { /* ignore */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function agent(repid: number, storedActivity: number, ledgerEvents = 0, shadowRows = 0) {
    const id = uuid();
    await db.from('repid_agents').insert({ id, agent_id: id, agent_name: `DG-${n}`, current_repid: repid, tier: 'ESTABLISHED', activity_30d: storedActivity, constitution: {} });
    for (let i = 0; i < ledgerEvents + shadowRows; i++) {
      await db.from('repid_score_events').insert({
        id: uuid(), agent_id: id, event_type: 'SERVICE_FULFILLED', delta: 0, repid_before: repid, repid_after: repid,
        is_shadow: i >= ledgerEvents, metadata: {}, created_at: new Date(Date.now() - (i + 1) * DAY / 4).toISOString(),
      });
    }
    return id;
  }
  const score = async (id: string) => (await db.from('repid_agents').select('*').eq('id', id).single()).data.current_repid;
  const lastDecay = async (id: string) => {
    const rows = (await db.from('repid_score_events').select('*').eq('agent_id', id)).data as any[];
    return rows[rows.length - 1].metadata.decay;
  };

  it('a zero-delta event moves no score (a simulated contract stays simulated)', async () => {
    const id = await agent(2000, 0);
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 0, { contract_id: uuid() });
    expect(await score(id)).toBe(2000);
    expect(await lastDecay(id)).toMatchObject({ applied: false, period_hit: false, skipped: 'zero_delta' });
  });

  it('decay lands at most once per 30-day window, not once per event', async () => {
    const id = await agent(2000, 0);
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    const first = await score(id);
    expect(first).toBeLessThan(2010); // decay landed on the first event
    expect(await lastDecay(id)).toMatchObject({ applied: true, period_hit: true, skipped: null });
    for (let i = 0; i < 3; i++) await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    expect(await score(id)).toBe(first + 30); // and never again inside the window
    expect(await lastDecay(id)).toMatchObject({ applied: false, period_hit: false, skipped: 'decayed_this_period' });
  });

  it('activity is read from the agent\'s own ledger, not repid_agents.activity_30d', async () => {
    // Stored 860 but no events: idle, so it decays.
    const idleButLabelledBusy = await agent(2000, 860, 0);
    await applyValidationEvent(idleButLabelledBusy, 'SERVICE_SATISFIED', 10);
    expect(await score(idleButLabelledBusy)).toBeLessThan(2010);
    expect((await lastDecay(idleButLabelledBusy)).activity_30d).toBe(0);

    // Stored 0 but trading: decays less than a truly idle agent at the same score.
    const busyButLabelledIdle = await agent(2000, 0, 60);
    const idle = await agent(2000, 0, 0);
    await applyValidationEvent(busyButLabelledIdle, 'SERVICE_SATISFIED', 10);
    await applyValidationEvent(idle, 'SERVICE_SATISFIED', 10);
    const busy = await lastDecay(busyButLabelledIdle);
    expect(busy.activity_30d).toBe(60);
    expect(busy.would_remove).toBeLessThan((await lastDecay(idle)).would_remove);
  });

  it('shadow-trigger rows are not activity', async () => {
    // Stored 5 so this cannot pass by reading the column; 40 shadow rows so it cannot pass by
    // counting them.
    const id = await agent(2000, 5, 0, 40);
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    expect((await lastDecay(id)).activity_30d).toBe(0);
  });

  it('shadow marks the same event enforce would decay, and still moves nothing', async () => {
    process.env.REPID_DECAY_MODE = 'shadow';
    const id = await agent(2000, 0);
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    expect(await lastDecay(id)).toMatchObject({ mode: 'shadow', applied: false, period_hit: true });
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    expect(await lastDecay(id)).toMatchObject({ period_hit: false, skipped: 'decayed_this_period' });
    expect(await score(id)).toBe(2020);
  });

  it('off reads no ledger and decays nothing', async () => {
    process.env.REPID_DECAY_MODE = 'off';
    const id = await agent(2000, 0);
    await applyValidationEvent(id, 'SERVICE_SATISFIED', 10);
    expect(await score(id)).toBe(2010);
    expect(await lastDecay(id)).toMatchObject({ mode: 'off', applied: false, period_hit: false, skipped: null });
  });
});
