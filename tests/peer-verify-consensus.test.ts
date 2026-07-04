import {
  computeConsensus,
  peerVerifyPanelEnabled,
  CONSENSUS_QUORUM,
  PANEL_SIZE,
  type PanelVote,
  type PanelVerdict,
} from '../src/services/peer-verify-consensus';

function vote(verdict: PanelVerdict, i = 0): PanelVote {
  return {
    verifier_agent_id: `agent-${i}`,
    verifier_agent_name: `trinity-${i}`,
    provider: 'groq',
    verdict,
  };
}

function panel(...verdicts: PanelVerdict[]): PanelVote[] {
  return verdicts.map((v, i) => vote(v, i));
}

describe('BLIND 2-of-3 panel — computeConsensus', () => {
  test('constants: 2-of-3', () => {
    expect(CONSENSUS_QUORUM).toBe(2);
    expect(PANEL_SIZE).toBe(3);
  });

  test('unanimous verified → verified', () => {
    const r = computeConsensus(panel('verified', 'verified', 'verified'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('verified');
    expect(r.reason).toBe('reached');
  });

  test('2-1 verified majority → verified', () => {
    const r = computeConsensus(panel('verified', 'verified', 'disputed'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('verified');
  });

  test('2-1 disputed majority → disputed', () => {
    const r = computeConsensus(panel('disputed', 'disputed', 'verified'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('disputed');
  });

  test('unanimous disputed → disputed', () => {
    const r = computeConsensus(panel('disputed', 'disputed', 'disputed'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('disputed');
  });

  test('quorum reached with one timeout (2 verified, 1 timeout) → verified', () => {
    const r = computeConsensus(panel('verified', 'verified', 'timeout'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('verified');
  });

  test('tie via timeout (1 verified, 1 disputed, 1 timeout) → NO consensus', () => {
    const r = computeConsensus(panel('verified', 'disputed', 'timeout'));
    expect(r.reached).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.reason).toBe('no_majority');
  });

  test('all timeout → NO consensus (all_timeout)', () => {
    const r = computeConsensus(panel('timeout', 'timeout', 'timeout'));
    expect(r.reached).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.reason).toBe('all_timeout');
  });

  test('only 1 vote in → insufficient (waiting)', () => {
    const r = computeConsensus(panel('verified'));
    expect(r.reached).toBe(false);
    expect(r.reason).toBe('insufficient_votes');
  });

  test('2 split votes in → insufficient (waiting, no majority yet)', () => {
    const r = computeConsensus(panel('verified', 'disputed'));
    expect(r.reached).toBe(false);
    expect(r.verdict).toBeNull();
  });

  test('2 agreeing votes in (early quorum) → verified before 3rd vote', () => {
    // 2-of-3 reached as soon as two agree; the 3rd is not required.
    const r = computeConsensus(panel('disputed', 'disputed'));
    expect(r.reached).toBe(true);
    expect(r.verdict).toBe('disputed');
  });

  test('empty votes → no consensus', () => {
    const r = computeConsensus([]);
    expect(r.reached).toBe(false);
    expect(r.reason).toBe('all_timeout');
  });
});

describe('BLIND 2-of-3 panel — flag gate', () => {
  const orig = process.env.PEER_VERIFY_PANEL_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.PEER_VERIFY_PANEL_ENABLED;
    else process.env.PEER_VERIFY_PANEL_ENABLED = orig;
  });

  test('defaults to false (prod behavior unchanged)', () => {
    delete process.env.PEER_VERIFY_PANEL_ENABLED;
    expect(peerVerifyPanelEnabled()).toBe(false);
  });

  test('true only when explicitly set', () => {
    process.env.PEER_VERIFY_PANEL_ENABLED = 'true';
    expect(peerVerifyPanelEnabled()).toBe(true);
    process.env.PEER_VERIFY_PANEL_ENABLED = 'false';
    expect(peerVerifyPanelEnabled()).toBe(false);
    process.env.PEER_VERIFY_PANEL_ENABLED = 'TRUE';
    expect(peerVerifyPanelEnabled()).toBe(true);
  });
});
