/**
 * Smoke test for the trinity_swarm_health view (CC Sprint 6).
 *
 * Verifies:
 *   1. View exists and returns exactly 12 rows (one per expected trinity-* worker)
 *   2. Every row has the expected agent_name + spokesperson cross-join
 *   3. Status color computes correctly per timestamp
 *   4. Spokesperson UUID matches the canonical mapping
 *
 * Skipped if SUPABASE env not set — same skip-when-no-env pattern as other
 * db-touching tests in this repo.
 */

import { db } from '../src/db';

// REPID_TEST_DUMMY_DB is set by tests/jest.setup.env.ts when only dummy creds are present
// (keyless CI). Real creds (.env / CI secrets) leave it unset, so this live-DB smoke test
// runs for real when a DB is available and skips cleanly otherwise.
const HAS_DB = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) && process.env.REPID_TEST_DUMMY_DB !== '1';
const describeIfDb = HAS_DB ? describe : describe.skip;

const EXPECTED_AGENTS = new Set([
  'trinity-orch','trinity-w3c','trinity-shofet','trinity-torch',
  'trinity-veritas','trinity-gcm','trinity-chesed','trinity-mel',
  'trinity-apm','trinity-sophia','trinity-nexus','trinity-hdm',
]);

const SPOKESPERSON_BY_SQUAD: Record<string, { name: string; uuid: string }> = {
  alpha:         { name: 'SOPHIA',  uuid: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271' },
  beta:          { name: 'VERITAS', uuid: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067' },
  gamma:         { name: 'SHOFET',  uuid: '32e0e809-c1c4-4405-913f-135c8a2d6626' },
  orchestration: { name: 'CHESED',  uuid: '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6' },
};

describeIfDb('trinity_swarm_health view', () => {
  it('exists and returns exactly 12 rows', async () => {
    const { data, error } = await db.from('trinity_swarm_health').select('*');
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data).toHaveLength(12);
  });

  it('every expected agent is represented (no missing rows)', async () => {
    const { data } = await db.from('trinity_swarm_health').select('agent_name');
    const seen = new Set((data ?? []).map((r: any) => r.agent_name));
    for (const a of EXPECTED_AGENTS) {
      expect(seen.has(a)).toBe(true);
    }
  });

  it('spokesperson cross-join matches canonical mapping for every row with a known squad', async () => {
    const { data } = await db.from('trinity_swarm_health')
      .select('agent_name, expected_squad, expected_spokesperson, spokesperson_uuid');
    for (const row of (data ?? []) as any[]) {
      if (row.expected_squad && SPOKESPERSON_BY_SQUAD[row.expected_squad]) {
        const expected = SPOKESPERSON_BY_SQUAD[row.expected_squad]!;
        expect(row.expected_spokesperson).toBe(expected.name);
        expect(row.spokesperson_uuid).toBe(expected.uuid);
      }
    }
  });

  it('status_color is one of {green, yellow, red}', async () => {
    const { data } = await db.from('trinity_swarm_health').select('status_color');
    for (const row of (data ?? []) as any[]) {
      expect(['green', 'yellow', 'red']).toContain(row.status_color);
    }
  });

  it('status_color=red when heartbeat is null OR > 60 min old', async () => {
    const { data } = await db.from('trinity_swarm_health')
      .select('agent_name, heartbeat_last_seen, minutes_since_last_seen, status_color');
    for (const row of (data ?? []) as any[]) {
      if (row.heartbeat_last_seen === null || (row.minutes_since_last_seen ?? 0) > 60) {
        expect(row.status_color).toBe('red');
      }
    }
  });

  it('minutes_since_last_seen is null IFF heartbeat_last_seen is null', async () => {
    const { data } = await db.from('trinity_swarm_health')
      .select('heartbeat_last_seen, minutes_since_last_seen');
    for (const row of (data ?? []) as any[]) {
      const tsNull = row.heartbeat_last_seen === null;
      const minsNull = row.minutes_since_last_seen === null;
      expect(tsNull).toBe(minsNull);
    }
  });
});
