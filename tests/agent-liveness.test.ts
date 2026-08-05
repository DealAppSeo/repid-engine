/**
 * agent-liveness.test.ts
 *
 * The property under test: **a self-reported status can never make an agent look
 * alive.** All 12 production heartbeat rows read status='online' with a last_ping
 * 18 days old [V sql 2026-08-04] — a dead agent cannot write 'offline', so the
 * last thing it ever wrote stays true-looking forever. A self-reported liveness
 * field is only ever wrong in the dangerous direction.
 */

import {
  deriveLiveness,
  summarizeFleet,
  LIVE_WINDOW_MIN,
  DEAD_AFTER_MIN,
  type HeartbeatRow,
} from '../src/observability/agent-liveness';

const NOW = Date.parse('2026-08-04T20:00:00Z');
const agoMin = (m: number) => new Date(NOW - m * 60000).toISOString();
const row = (o: Partial<HeartbeatRow> = {}): HeartbeatRow => ({ agent_name: 'trinity-x', status: 'online', last_ping: agoMin(1), ...o });

describe('state is derived from the timestamp, never from status', () => {
  it('is live inside the window', () => {
    expect(deriveLiveness(row({ last_ping: agoMin(1) }), NOW).state).toBe('live');
  });

  it('is stale past the live window but before the dead threshold', () => {
    expect(deriveLiveness(row({ last_ping: agoMin(LIVE_WINDOW_MIN + 1) }), NOW).state).toBe('stale');
  });

  it('is dead past the dead threshold', () => {
    expect(deriveLiveness(row({ last_ping: agoMin(DEAD_AFTER_MIN + 1) }), NOW).state).toBe('dead');
  });

  // THE PRODUCTION CASE: status='online', ping 18 days old.
  it('reports dead for the real fleet shape, not online', () => {
    const l = deriveLiveness(row({ status: 'online', last_ping: agoMin(18 * 24 * 60) }), NOW);
    expect(l.state).toBe('dead');
    expect(l.live).toBe(false);
    expect(l.selfReportedStatus).toBe('online');
    expect(l.selfReportContradicted).toBe(true);
  });

  it('an agent that never pinged is unknown, not dead', () => {
    // "Never observed" and "observed, then went silent" are different facts.
    for (const v of [null, undefined, '']) {
      expect(deriveLiveness(row({ last_ping: v as any }), NOW).state).toBe('unknown');
    }
  });

  it('an unparseable timestamp is unknown rather than silently fresh', () => {
    expect(deriveLiveness(row({ last_ping: 'not-a-date' }), NOW).state).toBe('unknown');
  });

  it('a future ping is clamped to 0 rather than reported as negative age', () => {
    // A clock-skew ping must not read as "very fresh" — but it is also not
    // evidence of death, so live is the honest answer with age pinned at 0.
    const l = deriveLiveness(row({ last_ping: new Date(NOW + 60 * 60000).toISOString() }), NOW);
    expect(l.minutesSinceLastPing).toBe(0);
    expect(l.state).toBe('live');
  });

  it('accepts a Date as well as a string', () => {
    expect(deriveLiveness(row({ last_ping: new Date(NOW - 60000) }), NOW).state).toBe('live');
  });
});

describe('boundaries are exact', () => {
  it('live window is exclusive at the edge', () => {
    expect(deriveLiveness(row({ last_ping: agoMin(LIVE_WINDOW_MIN - 0.01) }), NOW).state).toBe('live');
    expect(deriveLiveness(row({ last_ping: agoMin(LIVE_WINDOW_MIN) }), NOW).state).toBe('stale');
  });

  it('dead threshold is exclusive at the edge', () => {
    expect(deriveLiveness(row({ last_ping: agoMin(DEAD_AFTER_MIN - 0.01) }), NOW).state).toBe('stale');
    expect(deriveLiveness(row({ last_ping: agoMin(DEAD_AFTER_MIN) }), NOW).state).toBe('dead');
  });
});

describe('contradiction detection', () => {
  it('flags every phrasing an agent might use to claim it is up', () => {
    for (const s of ['online', 'ONLINE', 'running', 'active', 'up', 'healthy', '  Online  ']) {
      expect(deriveLiveness(row({ status: s, last_ping: agoMin(999) }), NOW).selfReportContradicted).toBe(true);
    }
  });

  it('does not flag a row that honestly reports itself down', () => {
    for (const s of ['offline', 'stopped', 'crashed', 'error']) {
      expect(deriveLiveness(row({ status: s, last_ping: agoMin(999) }), NOW).selfReportContradicted).toBe(false);
    }
  });

  it('does not flag a live agent that says it is online', () => {
    expect(deriveLiveness(row({ status: 'online', last_ping: agoMin(1) }), NOW).selfReportContradicted).toBe(false);
  });

  it('treats a missing status as no claim at all', () => {
    const l = deriveLiveness(row({ status: null, last_ping: agoMin(999) }), NOW);
    expect(l.selfReportedStatus).toBeNull();
    expect(l.selfReportContradicted).toBe(false);
  });
});

describe('summarizeFleet', () => {
  it('computes uptime from the DERIVED state — the bug that made a silent fleet read 100%', () => {
    const rows = [
      row({ agent_name: 'a', status: 'online', last_ping: agoMin(1) }),
      row({ agent_name: 'b', status: 'online', last_ping: agoMin(18 * 24 * 60) }),
      row({ agent_name: 'c', status: 'online', last_ping: agoMin(18 * 24 * 60) }),
      row({ agent_name: 'd', status: 'online', last_ping: agoMin(10) }),
    ];
    const f = summarizeFleet(rows, NOW);

    expect(f.total).toBe(4);
    expect(f.live).toBe(1);
    expect(f.stale).toBe(1);
    expect(f.dead).toBe(2);
    expect(f.uptimePct).toBe(25); // NOT 100, which is what status='online' x4 would have said
    expect(f.contradictions).toBe(3);
  });

  it('handles an empty fleet without dividing by zero', () => {
    const f = summarizeFleet([], NOW);
    expect(f).toMatchObject({ total: 0, live: 0, uptimePct: 0, contradictions: 0 });
  });

  it('every agent lands in exactly one state bucket', () => {
    const rows = [row({ last_ping: agoMin(1) }), row({ last_ping: agoMin(30) }), row({ last_ping: agoMin(9999) }), row({ last_ping: null })];
    const f = summarizeFleet(rows, NOW);
    expect(f.live + f.stale + f.dead + f.unknown).toBe(f.total);
  });
});
