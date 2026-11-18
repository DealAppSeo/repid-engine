/**
 * Due policy (risk / batch / age), fee ceiling before submission, overdue alert, and no double anchor
 * across a re-submitted batch or a retry after an ambiguous send. FAKE chain, injected clock.
 */
import { anchorKey, planDue, runDueAnchorSweep, type AnchorChainClient, type DuePolicy, type DueRow } from '../src/memory/memory-root-anchor-due';
import type { ProofAttestInput } from '../src/services/eas-attestation-service';

const H = 3_600_000;
const T0 = 1_763_424_000_000;
const policy: DuePolicy = { batchSize: 3, maxAgeMs: 6 * H, overdueAfterMs: 2 * H, feeCeilingWei: 2_000_000_000n };

const root = (n: number) => '0x' + n.toString(16).padStart(2, '0').repeat(32);
const row = (id: number, queuedAt: number, risk: 'high' | 'normal' = 'normal'): DueRow =>
  ({ id, agentId: `synthetic-agent-${id}`, tier: 'ESTABLISHED', root: root(id), epoch: 7, repidSnapshot: 1231, queuedAt, risk });

/** Fake chain: remembers every attestation that LANDED, keyed like the sweep keys them. */
function fakeChain(opts: { fee?: bigint; feeThrows?: boolean; loseReceiptOnce?: boolean } = {}) {
  const landed = new Map<string, { uid: string; txHash: string }>();
  let lose = !!opts.loseReceiptOnce;
  let n = 0;
  const client: AnchorChainClient = {
    feeWei: async () => { if (opts.feeThrows) throw new Error('rpc down'); return opts.fee ?? 1_000_000_000n; },
    findAnchor: async (key) => landed.get(key) ?? null,
    attest: async (i: ProofAttestInput) => {
      const key = anchorKey({ agentId: i.agentId, epoch: i.proofId, root: i.merkleRoot });
      const rec = { uid: `0xuid${++n}`, txHash: `0xtx${n}` };
      landed.set(key, rec);
      if (lose) { lose = false; throw new Error('timeout waiting for receipt'); }
      return rec;
    },
  };
  return { client, landed, sends: () => n };
}

describe('planDue', () => {
  it('nothing pending / young / low-risk below batch → not due', () => {
    expect(planDue([], T0, policy).due).toBe(false);
    expect(planDue([row(1, T0)], T0 + H, policy).due).toBe(false);
  });
  it('risk alone makes it due, and high risk jumps the queue', () => {
    const p = planDue([row(1, T0), row(2, T0 + H, 'high')], T0 + H, policy);
    expect(p.reasons).toEqual(['risk']);
    expect(p.ordered.map((r) => r.id)).toEqual([2, 1]);
  });
  it('batch size alone makes it due', () => {
    expect(planDue([row(1, T0), row(2, T0), row(3, T0)], T0, policy).reasons).toEqual(['batch']);
  });
  it('age alone makes it due', () => {
    expect(planDue([row(1, T0)], T0 + 6 * H, policy).reasons).toEqual(['age']);
  });
});

describe('runDueAnchorSweep', () => {
  const base = (rows: DueRow[], chain: AnchorChainClient, extra: Partial<Parameters<typeof runDueAnchorSweep>[0]> = {}) => {
    const written: Array<[number, string]> = [];
    const alerts: string[] = [];
    return {
      written, alerts,
      run: (nowMs = T0) => runDueAnchorSweep({
        fetchPending: async () => rows.filter((r) => !written.some(([id]) => id === r.id)),
        writeback: async (id, uid) => { written.push([id, uid]); },
        chain, policy, nowMs, mode: 'enforce', alert: (m) => alerts.push(m), ...extra,
      }),
    };
  };

  it('shadow mode never reads fee, never sends, never writes back', async () => {
    const c = fakeChain();
    const s = base([row(1, T0, 'high')], c.client, { mode: 'shadow' });
    const r = await s.run();
    expect(r.plan.due).toBe(true);
    expect(c.sends()).toBe(0);
    expect(s.written).toEqual([]);
  });

  it('fee AT the ceiling defers before submission', async () => {
    const c = fakeChain({ fee: policy.feeCeilingWei });
    const r = await base([row(1, T0, 'high')], c.client).run();
    expect(r.deferred).toBe('fee_at_or_above_ceiling');
    expect(c.sends()).toBe(0);
  });

  it('fee ABOVE the ceiling defers; unreadable fee defers as not checked', async () => {
    expect((await base([row(1, T0, 'high')], fakeChain({ fee: policy.feeCeilingWei + 1n }).client).run()).deferred).toBe('fee_at_or_above_ceiling');
    const c = fakeChain({ feeThrows: true });
    expect((await base([row(1, T0, 'high')], c.client).run()).deferred).toBe('fee_not_checked');
    expect(c.sends()).toBe(0);
  });

  it('fee below the ceiling anchors', async () => {
    const c = fakeChain({ fee: policy.feeCeilingWei - 1n });
    const s = base([row(1, T0, 'high')], c.client);
    const r = await s.run();
    expect(r.rows.map((x) => x.outcome)).toEqual(['anchored']);
    expect(s.written).toEqual([[1, '0xuid1']]);
  });

  it('a due batch that stays unanchored past overdueAfterMs raises an alert', async () => {
    const s = base([row(1, T0)], fakeChain({ fee: policy.feeCeilingWei }).client);
    await s.run(T0 + 6 * H + H);     // due (age), deferred by fee, not yet overdue
    expect(s.alerts).toEqual([]);
    await s.run(T0 + 6 * H + 2 * H); // due for 2h → overdue
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatch(/OVERDUE/);
  });

  it('the same batch submitted twice results in ONE anchor', async () => {
    const c = fakeChain();
    const rows = [row(1, T0, 'high')];
    // Second submission does not see the first writeback (e.g. a second replica / a failed writeback).
    const mk = () => runDueAnchorSweep({ fetchPending: async () => rows, writeback: async () => {}, chain: c.client, policy, nowMs: T0, mode: 'enforce', alert: () => {} });
    const a = await mk();
    const b = await mk();
    expect(a.rows[0]!.outcome).toBe('anchored');
    expect(b.rows[0]!.outcome).toBe('readback_existing');
    expect(c.sends()).toBe(1);
    expect(c.landed.size).toBe(1);
  });

  it('duplicate rows for the same root inside one run are sent once', async () => {
    const c = fakeChain();
    const dup = { ...row(1, T0, 'high'), id: 99 };
    const r = await base([row(1, T0, 'high'), dup], c.client).run();
    expect(r.rows.map((x) => x.outcome)).toEqual(['anchored', 'duplicate_in_run']);
    expect(c.sends()).toBe(1);
  });

  it('a retry after an ambiguous send reads back instead of resending → one anchor', async () => {
    const c = fakeChain({ loseReceiptOnce: true });
    const s = base([row(1, T0, 'high')], c.client);
    const first = await s.run();
    expect(first.rows[0]!.outcome).toBe('ambiguous');
    expect(s.written).toEqual([]);
    const retry = await s.run();
    expect(retry.rows[0]!.outcome).toBe('readback_existing');
    expect(s.written).toEqual([[1, '0xuid1']]);
    expect(c.sends()).toBe(1);
    expect(c.landed.size).toBe(1);
  });

  it('an unreadable readback refuses the send', async () => {
    const c = fakeChain();
    c.client.findAnchor = async () => { throw new Error('rpc down'); };
    const r = await base([row(1, T0, 'high')], c.client).run();
    expect(r.rows[0]!.outcome).toBe('failed');
    expect(c.sends()).toBe(0);
  });
});
