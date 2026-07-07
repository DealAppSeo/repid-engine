/**
 * Anti-Sybil MVP (2026-07-07) — detection→forfeiture wiring scaffold.
 * Proves: flag OFF inert; flag ON gates on confidence; a proposal opens an
 * appeal window and does NOT auto-apply the penalty; the upheld path calls the
 * deployed apply_repid_penalty RPC. No prod mutation (db mocked).
 */
import { proposeBondForfeiture, applyUpheldForfeiture } from '../../src/services/bond-forfeiture';

const rpc = jest.fn().mockResolvedValue({ data: null, error: null });
let configValue: string | null = '0.9';

jest.mock('../../src/db', () => {
  const b: any = {
    from: () => b,
    select: () => b,
    eq: () => b,
    update: () => b,
    maybeSingle: () => Promise.resolve({ data: { id: 'f-1', value: configValue }, error: null }),
    insert: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'f-1' }, error: null }) }) }),
    rpc: (...args: any[]) => rpc(...args),
  };
  return { db: b };
});

const VIOLATION = {
  targetAgentId: 'a-1', probeId: 'p-1', reason: 'sockpuppet_loop',
  confidence: 0.95, newRepid: 200, bondId: 'b-1', forfeitedAmountUsdcRaw: 5_000_000,
};

describe('bond-forfeiture wiring (spec §3–§4)', () => {
  const OLD = process.env.REPID_BOND_FORFEITURE_ENABLED;
  beforeEach(() => { rpc.mockClear(); configValue = '0.9'; });
  afterEach(() => {
    if (OLD === undefined) delete process.env.REPID_BOND_FORFEITURE_ENABLED;
    else process.env.REPID_BOND_FORFEITURE_ENABLED = OLD;
  });

  it('flag OFF (default): inert — no forfeiture proposed', async () => {
    delete process.env.REPID_BOND_FORFEITURE_ENABLED;
    const out = await proposeBondForfeiture(VIOLATION);
    expect(out.applied).toBe(false);
    expect(out.reason).toBe('forfeiture_disabled');
  });

  it('flag ON + confidence below min: no proposal', async () => {
    process.env.REPID_BOND_FORFEITURE_ENABLED = 'true';
    const out = await proposeBondForfeiture({ ...VIOLATION, confidence: 0.5 });
    expect(out.applied).toBe(false);
    expect(out.reason).toContain('confidence_below_min');
  });

  it('flag ON + proven: proposes with appeal window, does NOT auto-apply penalty', async () => {
    process.env.REPID_BOND_FORFEITURE_ENABLED = 'true';
    const out = await proposeBondForfeiture(VIOLATION);
    expect(out.applied).toBe(false); // due process: not applied on proposal
    expect(out.reason).toBe('proposed_pending_appeal_window');
    expect(out.forfeitureId).toBe('f-1');
    expect(rpc).not.toHaveBeenCalled(); // penalty NOT fired on mere proposal
  });

  it('upheld path applies the deployed apply_repid_penalty primitive', async () => {
    process.env.REPID_BOND_FORFEITURE_ENABLED = 'true';
    const out = await applyUpheldForfeiture('f-1', 'a-1', 200, { reason: 'sockpuppet_loop' });
    expect(out.applied).toBe(true);
    expect(rpc).toHaveBeenCalledWith('apply_repid_penalty', expect.objectContaining({
      p_agent: 'a-1', p_new_repid: 200,
    }));
  });

  it('upheld path is inert when flag OFF', async () => {
    delete process.env.REPID_BOND_FORFEITURE_ENABLED;
    const out = await applyUpheldForfeiture('f-1', 'a-1', 200, {});
    expect(out.applied).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
