/**
 * GET /api/v1/status must not pass history off as the current state (CC1 2026-10-15).
 *
 * Measured on production before this change: `audit_status` was the single audit-probe run ever
 * recorded (2026-05-25, WARN), shown with no age as if current, and `last_heartbeat` was a bare
 * null that could mean "never ran", "read failed" or "fine". Now every telemetry field says its
 * age and state, and a missing one says why.
 */
const rows: Record<string, { data?: any[]; error?: any }> = {};
jest.mock('../src/db', () => {
  const chain = (table: string) => {
    let family = '';
    const q: any = {
      select: () => q, gte: () => q, ilike: () => q, order: () => q,
      eq: (col: string, v: string) => { if (col === 'metric_family') family = v; return q; },
      limit: () => Promise.resolve(rows[`${table}:${family}`] ?? { data: [], error: null }),
      then: (ok: any) => Promise.resolve({ data: [], count: 0, error: null }).then(ok),
    };
    return q;
  };
  return { db: { from: (t: string) => chain(t) } };
});

import express from 'express';
import request from 'supertest';
import router, { ageOf, describeAudit, describeHeartbeat, STATUS_STALE_AFTER_DAYS } from '../src/routes/v1/launch-status';

const NOW = Date.parse('2026-10-15T04:00:00Z');
const DAY = 86_400_000;

describe('ageOf', () => {
  it('reports age in days and flags anything past the stale line', () => {
    expect(ageOf(new Date(NOW - 1 * DAY).toISOString(), NOW)).toEqual({ age_days: 1, stale: false });
    expect(ageOf(new Date(NOW - (STATUS_STALE_AFTER_DAYS + 0.1) * DAY).toISOString(), NOW).stale).toBe(true);
    expect(ageOf('2026-05-25T07:35:31.615+00:00', NOW)).toEqual({ age_days: 142.9, stale: true });
  });

  it('treats an unreadable time as stale, never as fresh', () => {
    expect(ageOf('not a date', NOW)).toEqual({ age_days: null, stale: true });
  });
});

describe('audit_status', () => {
  it('the production case: one WARN run from 2026-05-25 is labelled stale, with its age and why', () => {
    const out = describeAudit({ kind: 'row', at: '2026-05-25T07:35:31.615+00:00', value: { overall: 'WARN' } }, NOW);
    expect(out).toMatchObject({ at: '2026-05-25T07:35:31.615+00:00', overall: 'WARN', age_days: 142.9, state: 'stale' });
    expect((out as any).note).toMatch(/142\.9 days ago; none has run since, so this is not the current state/);
  });

  it('a run inside the window is current and carries no note', () => {
    const out = describeAudit({ kind: 'row', at: new Date(NOW - 3600_000).toISOString(), value: { overall: 'PASS' } }, NOW);
    expect(out).toMatchObject({ overall: 'PASS', state: 'current' });
    expect(out).not.toHaveProperty('note');
  });

  it('never recorded and could not read are different answers', () => {
    expect(describeAudit({ kind: 'none' }, NOW)).toEqual({ at: null, overall: null, state: 'not_reported', reason: 'no audit probe has been recorded' });
    expect(describeAudit({ kind: 'error' }, NOW)).toEqual({ at: null, overall: null, state: 'unknown', reason: 'the telemetry read failed' });
  });
});

describe('last_heartbeat', () => {
  it('is never a bare null: none recorded says so, and says which heartbeat it means', () => {
    const out = describeHeartbeat({ kind: 'none' }, NOW);
    expect(out).toEqual({ at: null, state: 'not_reported', reason: expect.stringMatching(/no economic-loop heartbeat has been recorded/) });
  });

  it('an old heartbeat is stale with its age; a fresh one is current', () => {
    expect(describeHeartbeat({ kind: 'row', at: new Date(NOW - 10 * DAY).toISOString(), value: { ok: true } }, NOW))
      .toMatchObject({ age_days: 10, state: 'stale' });
    expect(describeHeartbeat({ kind: 'row', at: new Date(NOW - 60_000).toISOString(), value: { ok: true } }, NOW))
      .toMatchObject({ state: 'current', result: { ok: true } });
  });
});

describe('GET /api/v1/status, through the route', () => {
  const app = express();
  app.use('/api/v1', router);

  beforeEach(() => {
    for (const k of Object.keys(rows)) delete rows[k];
  });

  it('serves the stale audit run labelled, and the missing heartbeat explained', async () => {
    rows['repid_telemetry_snapshots:audit_probe'] = {
      data: [{ metric_name: 'integrity_run', metric_value: { overall: 'WARN' }, snapshot_at: '2026-05-25T07:35:31.615+00:00' }],
      error: null,
    };
    const res = await request(app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.audit_status).toMatchObject({ at: '2026-05-25T07:35:31.615+00:00', overall: 'WARN', state: 'stale' });
    expect(res.body.audit_status.age_days).toBeGreaterThan(100);
    expect(res.body.last_heartbeat).toMatchObject({ at: null, state: 'not_reported' });
  });

  it('a failed telemetry read reads as unknown, not as "never ran"', async () => {
    rows['repid_telemetry_snapshots:audit_probe'] = { data: undefined, error: { message: 'boom' } };
    const res = await request(app).get('/api/v1/status');
    expect(res.body.audit_status).toMatchObject({ state: 'unknown' });
  });
});
