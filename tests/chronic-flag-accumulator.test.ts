import { shouldTriggerPeerVerify, maybeTriggerChronicFlag } from '../src/services/chronic-flag-accumulator';

/** Minimal db double: configurable flag count + capture peer-verify inserts. */
function makeDb(flagCount: number, captured: any[]) {
  const rows = Array.from({ length: flagCount }, (_, i) => ({ id: i }));
  return {
    from(table: string) {
      if (table === 'repid_score_events') {
        const chain: any = { select: () => chain, eq: () => chain, gte: () => Promise.resolve({ data: rows, error: null }) };
        return chain;
      }
      if (table === 'peer_verification_queue') {
        return { insert: (row: any) => { captured.push(row); return Promise.resolve({ error: null }); } };
      }
      return { select: () => ({}), insert: () => Promise.resolve({ error: null }) };
    },
  };
}

describe('C-2 chronic-flag accumulator', () => {
  const save = { ...process.env };
  afterEach(() => { process.env = { ...save }; });

  it('shouldTriggerPeerVerify is a simple threshold', () => {
    expect(shouldTriggerPeerVerify(4, 5)).toBe(false);
    expect(shouldTriggerPeerVerify(5, 5)).toBe(true);
  });

  it('default OFF → never enqueues, even past threshold', async () => {
    delete process.env.HAL_CHRONIC_FLAG_ENABLED;
    const captured: any[] = [];
    const r = await maybeTriggerChronicFlag(makeDb(10, captured), 'agent-1');
    expect(r.triggered).toBe(false);
    expect(r.enqueued).toBe(false);
    expect(captured).toHaveLength(0);
    expect(r.reason).toMatch(/disabled/);
  });

  it('enabled + N flags >= threshold → enqueues a peer-verify (NOT a slash)', async () => {
    process.env.HAL_CHRONIC_FLAG_ENABLED = 'true';
    process.env.HAL_CHRONIC_FLAG_THRESHOLD = '5';
    const captured: any[] = [];
    const r = await maybeTriggerChronicFlag(makeDb(6, captured), 'agent-1', 'recent work');
    expect(r.triggered).toBe(true);
    expect(r.enqueued).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ source_agent_id: 'agent-1', verification_status: 'pending', threshold_used: 5 });
  });

  it('enabled but below threshold → no enqueue', async () => {
    process.env.HAL_CHRONIC_FLAG_ENABLED = 'true';
    process.env.HAL_CHRONIC_FLAG_THRESHOLD = '5';
    const captured: any[] = [];
    const r = await maybeTriggerChronicFlag(makeDb(3, captured), 'agent-1');
    expect(r.triggered).toBe(false);
    expect(captured).toHaveLength(0);
  });
});
