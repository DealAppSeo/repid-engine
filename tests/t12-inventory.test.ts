/**
 * Loop C — T12 public snapshot 2026-09-19.
 * Fails until every served proof is ≤ 7 days. No remint in this ticket.
 */
const SNAPSHOT = [
  { agent: 'trinity-orch', ageDays: 8.8 },
  { agent: 'trinity-w3c', ageDays: 2.2 },
  { agent: 'trinity-torch', ageDays: 10.8 },
  { agent: 'trinity-gcm', ageDays: 9.8 },
  { agent: 'trinity-chesed', ageDays: 12.8 },
  { agent: 'trinity-mel', ageDays: 11.8 },
  { agent: 'trinity-apm', ageDays: 13.8 },
  { agent: 'trinity-sophia', ageDays: 6.2 },
  { agent: 'trinity-nexus', ageDays: 0.8 },
  { agent: 'trinity-hdm', ageDays: 16.8 },
  { agent: 'trinity-shofet', ageDays: 5.0 },
  { agent: 'trinity-veritas', ageDays: 0.8 },
];

describe('T12 served-proof freshness inventory (public 2026-09-19)', () => {
  it('no T12 served proof is older than 7 days', () => {
    const stale = SNAPSHOT.filter((a) => a.ageDays > 7).map((a) => a.agent);
    expect(stale).toEqual([]);
  });
});
