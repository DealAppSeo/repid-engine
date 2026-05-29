/**
 * Tests for the agent coordination helpers (sprint 2026-05-29).
 *
 * These mock src/db/direct-pg.pgQuery to assert SQL shape + params (the helpers
 * write as the RLS-bypass `postgres` role, so the meaningful invariant is that
 * the EXECUTION GATE `approved_by_sean = true` is in the claim SQL).
 *
 * The RLS boundary itself (anon denied 42501 / backend allowed) was proven
 * LIVE against the DB in rolled-back transactions — see CC_AGENT_COORDINATION_TABLES.md.
 */

const calls: Array<{ text: string; params: any[] }> = [];
(global as any).__pgReturn = [] as any[];

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: async (text: string, params: any[]) => {
    calls.push({ text, params });
    return (global as any).__pgReturn;
  },
}));

import { writeReport, claimDispatch } from '../src/services/agent-coordination';

beforeEach(() => { calls.length = 0; (global as any).__pgReturn = []; });

describe('writeReport', () => {
  it('inserts into agent_reports with the 7 columns and returns the row', async () => {
    (global as any).__pgReturn = [{ id: 'r1', sprint_id: 's', agent: 'CC', status: 'complete', created_at: 't' }];
    const row = await writeReport({ sprintId: 's', agent: 'CC', status: 'complete', keyFindings: 'k', flagsForSean: [{ x: 1 }], verifiedBy: 'GA' });

    expect(row.id).toBe('r1');
    const c = calls[0]!;
    expect(c.text).toMatch(/INSERT INTO public\.agent_reports/i);
    expect(c.text).toMatch(/RETURNING id, sprint_id, agent, status, created_at/i);
    expect(c.text).toMatch(/\$6::jsonb/); // flags_for_sean cast
    expect(c.params[0]).toBe('s');
    expect(c.params[1]).toBe('CC');
    expect(c.params[2]).toBe('complete');
    expect(c.params[5]).toBe(JSON.stringify([{ x: 1 }])); // serialized jsonb
    expect(c.params[6]).toBe('GA');
  });

  it('nulls optional fields (incl. flags) when omitted', async () => {
    (global as any).__pgReturn = [{ id: 'r2', sprint_id: 's', agent: 'XC', status: 'blocked', created_at: 't' }];
    await writeReport({ sprintId: 's', agent: 'XC', status: 'blocked' });
    const c = calls[0]!;
    expect(c.params[3]).toBeNull(); // report_path
    expect(c.params[4]).toBeNull(); // key_findings
    expect(c.params[5]).toBeNull(); // flags_for_sean
    expect(c.params[6]).toBeNull(); // verified_by
  });

  it('throws if the insert returns no row', async () => {
    (global as any).__pgReturn = [];
    await expect(writeReport({ sprintId: 's', agent: 'CC', status: 'x' })).rejects.toThrow(/no row/);
  });
});

describe('claimDispatch', () => {
  it('claim SQL enforces the approved_by_sean execution gate + pending + ordering + skip-locked', async () => {
    (global as any).__pgReturn = [{ id: 'd1', sprint_id: 's2', dispatch_type: 'build', target_agent: null, payload: {}, status: 'claimed', approved_by_sean: true, claimed_by: 'CC', claimed_at: 't' }];
    const row = await claimDispatch({ agent: 'CC', dispatchType: 'build' });

    expect(row?.id).toBe('d1');
    expect(row?.status).toBe('claimed');
    const c = calls[0]!;
    expect(c.text).toMatch(/UPDATE public\.dispatch_queue/i);
    expect(c.text).toMatch(/approved_by_sean = true/);          // THE GATE
    expect(c.text).toMatch(/status = 'pending'/);
    expect(c.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(c.text).toMatch(/ORDER BY created_at ASC/);
    expect(c.params).toEqual(['CC', 'build']);
  });

  it('returns null when nothing is claimable (no approved pending dispatch)', async () => {
    (global as any).__pgReturn = [];
    const row = await claimDispatch({ agent: 'GA' });
    expect(row).toBeNull();
    expect(calls[0]!.params).toEqual(['GA', null]);
  });
});
