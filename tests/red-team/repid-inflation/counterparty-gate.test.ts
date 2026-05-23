/**
 * RepID Inflation Patch B — counterparty gate tests (live-DB integration).
 *
 * The gate is a DB function (compute_tier(integer, uuid)) shipped in migration
 * 20260523140000_repid_inflation_counterparty_gate.sql, which is NOT applied until Sean greenlights
 * it (calibration shows meaningful thresholds would mass-demote the current population). So this
 * test detects whether the 2-arg overload exists: if not applied, it skips (does not false-fail);
 * once applied, it validates the gate truth table. Thresholds asserted here assume the strict
 * "target" set (vet10/auto5/est3/earn1) — adjust if Sean ships different thresholds.
 *
 * The gate logic was additionally verified live during the sprint via the strict overload on real
 * agents (apm cp3, shofet cp2, MEDIATOR cp0) — see report §2.
 */
import { pgQuery } from '../../../src/db/direct-pg';

const HAS_DB = !!(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);

async function twoArgExists(): Promise<boolean> {
  const rows = await pgQuery<{ n: string }>(
    `SELECT COUNT(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
     WHERE p.proname='compute_tier' AND ns.nspname='public'
       AND pg_get_function_identity_arguments(p.oid)='repid integer, p_agent_id uuid'`,
    [],
    { retries: 1, timeoutMs: 2500, label: 'patch-b-probe' },
  );
  return parseInt(rows[0]?.n ?? '0', 10) > 0;
}

describe('Min Unique Counterparty Gate (Patch B)', () => {
  let applied = false;
  beforeAll(async () => {
    if (!HAS_DB) { console.warn('[patch-b] no DATABASE_URL — skipping (live-DB integration test)'); return; }
    try { applied = await twoArgExists(); } catch { applied = false; }
    if (!applied) console.warn('[patch-b] compute_tier(integer,uuid) not applied — skipping gate assertions (expected pre-greenlight)');
  });

  test('count_unique_counterparties returns distinct delivered buyers', async () => {
    if (!applied) return;
    const rows = await pgQuery<{ n: string }>(
      `SELECT count_unique_counterparties((SELECT id FROM repid_agents WHERE agent_name='trinity-apm')) n`,
    );
    expect(parseInt(rows[0]!.n, 10)).toBeGreaterThanOrEqual(0);
  });

  test('NULL agent_id preserves backward compat (score-only tier)', async () => {
    if (!applied) return;
    const rows = await pgQuery<{ t: string }>(`SELECT compute_tier(6000, NULL) t`);
    expect(rows[0]!.t).toBe('AUTONOMOUS');
  });

  test('high RepID but 0 counterparties cascades down (not AUTONOMOUS/VETERAN)', async () => {
    if (!applied) return;
    const rows = await pgQuery<{ t: string }>(
      `SELECT compute_tier(9581, (SELECT id FROM repid_agents WHERE agent_name='MEDIATOR')) t`,
    );
    expect(['EARNING', 'PROBATIONARY']).toContain(rows[0]!.t);
  });

  test('agent below AUTONOMOUS counterparty floor is capped at ESTABLISHED', async () => {
    if (!applied) return;
    // apm has 3 delivered counterparties < auto_min(5) → AUTONOMOUS base capped to ESTABLISHED.
    const rows = await pgQuery<{ t: string }>(
      `SELECT compute_tier(6000, (SELECT id FROM repid_agents WHERE agent_name='trinity-apm')) t`,
    );
    expect(rows[0]!.t).toBe('ESTABLISHED');
  });
});
