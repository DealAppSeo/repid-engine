/**
 * node-registry — the consolidated (node, lane) record.
 *
 * The cases that matter are the ones where a naive implementation is silently wrong:
 * two nodes claiming one lane, a promoted-but-dead HAL voter, and a lease that outlives
 * the liveness signal.
 */
import {
  LIVENESS_WINDOW_MS,
  halVoters,
  isLive,
  leaseActive,
  toLeaseRegistry,
  triageOnly,
  validateNode,
  type NodeRecord,
} from '../src/orchestration/node-registry';
import { acquireLease, activeLeases, HEARTBEAT_TTL_MS } from '../src/orchestration/write-lease';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const node = (over: Partial<NodeRecord> = {}): NodeRecord => ({
  nodeId: 'laptop-01',
  surface: 'claude-code',
  lane: 'hal',
  owns: ['src/hal/**'],
  branch: 'feat/hal',
  purpose: 'HAL quorum work',
  models: ['gemma-4-26b'],
  canProve: false,
  canHalVote: false,
  acquiredAt: iso(NOW - 60_000),
  heartbeatAt: iso(NOW - 60_000),
  expiresAt: iso(NOW + HEARTBEAT_TTL_MS),
  ...over,
});

describe('liveness is DERIVED, never stored', () => {
  it('a fresh heartbeat is live', () => {
    expect(isLive(node(), NOW)).toBe(true);
  });

  it('a stale heartbeat is not live, even though nothing marked it dead', () => {
    expect(isLive(node({ heartbeatAt: iso(NOW - LIVENESS_WINDOW_MS - 1) }), NOW)).toBe(false);
  });

  it('an UNPARSEABLE heartbeat is not live — cannot say when it spoke, so it did not', () => {
    expect(isLive(node({ heartbeatAt: 'whenever' }), NOW)).toBe(false);
  });

  it('reuses v_fleet_truth‘s 10-minute window rather than inventing a second one', () => {
    expect(LIVENESS_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it('THE GAP ON PURPOSE: a node goes dark BEFORE its lease expires', () => {
    // Heartbeat 11 min old: past the liveness window, still inside the 15m lease.
    const n = node({
      heartbeatAt: iso(NOW - 11 * 60_000),
      expiresAt: iso(NOW + 4 * 60_000),
    });
    expect(isLive(n, NOW)).toBe(false);
    expect(leaseActive(n, NOW)).toBe(true);
    expect(LIVENESS_WINDOW_MS).toBeLessThan(HEARTBEAT_TTL_MS);
  });
});

describe('HAL voting is fail-closed', () => {
  it('a new node cannot vote by default', () => {
    expect(node().canHalVote).toBe(false);
    expect(halVoters([node()], NOW)).toHaveLength(0);
  });

  it('THE CASE THAT WOULD INFLATE PANEL WIDTH: promoted but DEAD is not a voter', () => {
    const dead = node({ canHalVote: true, heartbeatAt: iso(NOW - LIVENESS_WINDOW_MS - 1) });
    expect(halVoters([dead], NOW)).toHaveLength(0);
  });

  it('promoted AND live counts', () => {
    expect(halVoters([node({ canHalVote: true })], NOW)).toHaveLength(1);
  });

  it('a live unpromoted node is triage-only, not silently excluded from existence', () => {
    expect(triageOnly([node()], NOW)).toHaveLength(1);
  });
});

describe('bridge to write-lease: one overlap detector, not two', () => {
  it('THE SUBTLETY: two nodes claiming the SAME lane collide instead of both winning', () => {
    const a = node({ nodeId: 'laptop-01', lane: 'hal', owns: ['src/hal/**'] });
    const b = node({ nodeId: 'vps-01', lane: 'hal', owns: ['src/hal/**'] });
    const reg = toLeaseRegistry([a]);
    // Keyed on lane ALONE this would read as `hal` renewing itself and be granted.
    const r = acquireLease(
      reg,
      { lane: `${b.lane}@${b.nodeId}`, paths: b.owns, branch: 'x', purpose: 'y' },
      NOW,
    );
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });

  it('the same node renewing its own lane still succeeds', () => {
    const a = node();
    const r = acquireLease(
      toLeaseRegistry([a]),
      { lane: `${a.lane}@${a.nodeId}`, paths: a.owns, branch: 'x', purpose: 'y' },
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it('different lanes on different nodes coexist — the point of parallel lanes', () => {
    const reg = toLeaseRegistry([
      node({ nodeId: 'a', lane: 'hal', owns: ['src/hal/**'] }),
      node({ nodeId: 'b', lane: 'zkp', owns: ['src/zkp/**'] }),
    ]);
    expect(activeLeases(reg, NOW)).toHaveLength(2);
  });

  it('expired records drop out of the bridged registry', () => {
    const reg = toLeaseRegistry([node({ expiresAt: iso(NOW - 1) })]);
    expect(activeLeases(reg, NOW)).toHaveLength(0);
  });
});

describe('validation catches the cheap mistakes here, not in production', () => {
  it('accepts a well-formed record', () => {
    expect(validateNode(node()).ok).toBe(true);
  });

  it('rejects an unknown lane', () => {
    const v = validateNode(node({ lane: 'marketing' }));
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/unknown lane/);
  });

  it('rejects an empty claim', () => {
    expect(validateNode(node({ owns: [] })).ok).toBe(false);
  });

  it('THE FENCE: a node cannot claim paths OUTSIDE its lane', () => {
    const v = validateNode(node({ lane: 'hal', owns: ['src/zkp/**'] }));
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/outside lane/);
  });

  it('a SUBSET of the lane is fine — a node need not claim the whole lane', () => {
    expect(validateNode(node({ lane: 'hal', owns: ['src/hal/lib/**'] })).ok).toBe(true);
  });

  it('rejects an unparseable expiry', () => {
    expect(validateNode(node({ expiresAt: 'soon' })).ok).toBe(false);
  });
});
