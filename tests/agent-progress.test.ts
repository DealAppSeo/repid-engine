/**
 * agent-progress.test.ts
 *
 * The property under test: **a loop that iterates without producing is not
 * healthy.** `agent-liveness.test.ts` already pins the ping-vs-status half; this
 * pins the half that half cannot see.
 *
 * THE REGRESSION THIS EXISTS FOR [V sql 2026-08-17]. `trinity-mel` stopped
 * producing ~2026-06-19 and kept pinging until 07-17. Every ping-based check
 * read it as live for four weeks. Its heartbeat row carried the answer in two
 * adjacent columns the whole time — loop_count 19,155, tasks_completed_session 0,
 * against a peer band of 4,271-4,388 loops and 380-2,078 completions.
 *
 * The endpoint this logic was ported from would have called it HEALTHY: it
 * classified on `loop_count > 0` plus a fresh ping, and mel satisfied both.
 */

import {
  deriveProgress,
  deriveHealth,
  summarizeFleetHealth,
  SPIN_FLOOR_LOOPS,
  type ProgressRow,
} from '../src/observability/agent-liveness';

const NOW = Date.parse('2026-07-01T12:00:00Z');
const agoMin = (m: number) => new Date(NOW - m * 60000).toISOString();

const row = (o: Partial<ProgressRow> = {}): ProgressRow => ({
  agent_name: 'trinity-x',
  status: 'online',
  last_ping: agoMin(1),
  loop_count: 4380,
  tasks_completed_session: 2000,
  tasks_failed_session: 0,
  ...o,
});

describe('THE REGRESSION: the trinity-mel row shape', () => {
  // Its real values, on a date when it was pinging and producing nothing.
  const mel = row({
    agent_name: 'trinity-mel',
    status: 'online',
    last_ping: agoMin(1),
    loop_count: 19155,
    tasks_completed_session: 0,
  });

  it('is spinning, not producing', () => {
    expect(deriveProgress(mel).state).toBe('spinning');
    expect(deriveProgress(mel).spinningWithoutOutput).toBe(true);
  });

  it('is still LIVE — the ping half was never wrong, only incomplete', () => {
    const h = deriveHealth(mel, NOW);
    expect(h.live).toBe(true);
    expect(h.state).toBe('live');
    expect(h.selfReportContradicted).toBe(false);
  });

  it('is NOT healthy, which is the whole point', () => {
    expect(deriveHealth(mel, NOW).healthy).toBe(false);
  });
});

describe('the peer band stays healthy — no false alarm on working agents', () => {
  // The real observed extremes of the other eleven.
  it.each([
    ['fewest loops, fewest completions', 4271, 380],
    ['most loops, most completions', 4388, 2078],
  ])('%s', (_label, loops, completed) => {
    const h = deriveHealth(row({ loop_count: loops, tasks_completed_session: completed }), NOW);
    expect(h.progress.state).toBe('producing');
    expect(h.healthy).toBe(true);
  });
});

describe('a young session is not accused of spinning', () => {
  it('zero completions just after boot is unknown, not spinning', () => {
    const p = deriveProgress(row({ loop_count: SPIN_FLOOR_LOOPS - 1, tasks_completed_session: 0 }));
    expect(p.state).toBe('unknown');
    expect(p.spinningWithoutOutput).toBe(false);
  });

  it('but crossing the floor with nothing done IS spinning', () => {
    expect(deriveProgress(row({ loop_count: SPIN_FLOOR_LOOPS, tasks_completed_session: 0 })).state).toBe(
      'spinning'
    );
  });

  it('a young session that HAS completed work is already producing', () => {
    expect(deriveProgress(row({ loop_count: 5, tasks_completed_session: 2 })).state).toBe('producing');
  });
});

describe('absence is reported as absence', () => {
  it('a null loop_count is unknown, never a fault', () => {
    expect(deriveProgress(row({ loop_count: null })).state).toBe('unknown');
  });

  it('an unwired agent that pings is still healthy — unknown must not block it', () => {
    expect(deriveHealth(row({ loop_count: null, tasks_completed_session: null }), NOW).healthy).toBe(true);
  });

  it('looping with a null completion counter is unknown, not spinning', () => {
    expect(deriveProgress(row({ loop_count: 9000, tasks_completed_session: null })).state).toBe('unknown');
  });

  it('a loop that never started is not_looping, and not healthy', () => {
    expect(deriveProgress(row({ loop_count: 0 })).state).toBe('not_looping');
    expect(deriveHealth(row({ loop_count: 0, tasks_completed_session: 0 }), NOW).healthy).toBe(false);
  });
});

describe('a dead agent stays not-healthy regardless of its counters', () => {
  it('stale ping with good counters is not healthy', () => {
    const h = deriveHealth(row({ last_ping: agoMin(24 * 60) }), NOW);
    expect(h.live).toBe(false);
    expect(h.healthy).toBe(false);
  });
});

describe('fleet summary counts what a live-only view hides', () => {
  it('a fully live, fully spinning fleet reports 0% healthy — not 100%', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ agent_name: `trinity-${i}`, loop_count: 19155, tasks_completed_session: 0 })
    );
    const s = summarizeFleetHealth(rows, NOW);
    // The old reading, preserved so the difference is visible in one assertion.
    expect(s.live).toBe(12);
    expect(s.uptimePct).toBe(100);
    // The reading that would have caught it.
    expect(s.spinning).toBe(12);
    expect(s.healthy).toBe(0);
    expect(s.healthyPct).toBe(0);
  });

  it('the real 2026-06 fleet — eleven working, mel spinning', () => {
    const rows: ProgressRow[] = [
      ...Array.from({ length: 11 }, (_, i) =>
        row({ agent_name: `trinity-peer-${i}`, loop_count: 4380, tasks_completed_session: 1500 })
      ),
      row({ agent_name: 'trinity-mel', loop_count: 19155, tasks_completed_session: 0 }),
    ];
    const s = summarizeFleetHealth(rows, NOW);
    expect(s.total).toBe(12);
    expect(s.live).toBe(12);
    expect(s.healthy).toBe(11);
    expect(s.spinning).toBe(1);
    expect(s.fleet.find((a) => a.agentName === 'trinity-mel')?.healthy).toBe(false);
  });

  it('an empty fleet is 0%, not a division by zero', () => {
    const s = summarizeFleetHealth([], NOW);
    expect(s.healthyPct).toBe(0);
    expect(s.healthy).toBe(0);
  });
});
