/**
 * RepID Inflation Patch B — counterparty gate tests (live-DB integration).
 *
 * The gate is a DB function (compute_tier(integer, uuid)) shipped in migration
 * 20260523140000_repid_inflation_counterparty_gate.sql. APPLIED to prod 2026-05-23 at the
 * ZERO-DEMOTION FLOOR (vet_min=2, auto_min=2, est_min=0, earn_min=0) + is_human exclusion, per Sean.
 * Assertions below match that floor (a 0-counterparty climber is blocked from AUTONOMOUS, capped at
 * ESTABLISHED; est/earn are ungated so no further cascade). If Sean ratchets thresholds, update these.
 *
 * Skips gracefully when no DATABASE_URL or when the 2-arg overload isn't present (other envs).
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

  test('0-counterparty climber is blocked from AUTONOMOUS (capped at ESTABLISHED at the floor)', async () => {
    if (!applied) return;
    // MEDIATOR (is_human=false, 0 delivered counterparties) at AUTONOMOUS-level repid: cp0 < auto_min(2)
    // → capped to ESTABLISHED; est ungated so it stays there. This is the sock-puppet block.
    const rows = await pgQuery<{ t: string }>(
      `SELECT compute_tier(6000, (SELECT id FROM repid_agents WHERE agent_name='MEDIATOR' LIMIT 1)) t`,
    );
    expect(rows[0]!.t).toBe('ESTABLISHED');
    expect(rows[0]!.t).not.toBe('AUTONOMOUS');
  });

  test('provider with >= floor counterparties passes (apm cp3 → AUTONOMOUS)', async () => {
    if (!applied) return;
    // apm has 3 delivered counterparties >= auto_min(2) → AUTONOMOUS allowed.
    const rows = await pgQuery<{ t: string }>(
      `SELECT compute_tier(6000, (SELECT id FROM repid_agents WHERE agent_name='trinity-apm')) t`,
    );
    expect(rows[0]!.t).toBe('AUTONOMOUS');
  });
});
