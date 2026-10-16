import {
  resolveOutcome,
  summarize,
  summarizeBy,
  parseClaimIs,
  parseConfidence01,
  MemoryCalibrationStore,
  DbCalibrationStore,
  CALIBRATION_SHADOW_TABLE,
  type SelfRating,
  type PeerRating,
} from '../src/rrl/peer-calibration';

const self = (o: Partial<SelfRating> = {}): SelfRating => ({ task_id: 't1', agent_id: 'a', family: 'openai', self_claim_is: 'TRUE', self_confidence: 0.9, ...o });
const peer = (rater_family: string, answer_is: PeerRating['answer_is'], o: Partial<PeerRating> = {}): PeerRating => ({
  task_id: 't1', subject_agent_id: 'a', rater_agent_id: `r-${rater_family}`, rater_family, answer_is, ...o,
});

describe('peer calibration: resolution', () => {
  it('two other families agreeing resolve the outcome', () => {
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('nvidia', 'TRUE')])).toMatchObject({ status: 'resolved', correct: 1 });
    expect(resolveOutcome(self(), [peer('google', 'FALSE'), peer('nvidia', 'FALSE')])).toMatchObject({ status: 'resolved', correct: 0 });
  });

  it('one family, a same-family rater, or a self-rating never resolves', () => {
    expect(resolveOutcome(self(), [peer('google', 'TRUE')]).status).toBe('unresolved');
    // Same family as the subject: one model's error must not confirm itself.
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('openai', 'TRUE')]).status).toBe('unresolved');
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('nvidia', 'TRUE', { rater_agent_id: 'a' })]).status).toBe('unresolved');
    // Two raters of ONE family are one opinion.
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('google', 'TRUE', { rater_agent_id: 'r2' })]).status).toBe('unresolved');
  });

  it('disagreeing families, an UNDETERMINED peer, or a family that said both do not resolve', () => {
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('nvidia', 'FALSE')])).toMatchObject({ status: 'unresolved', reason: 'peer families disagree' });
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('nvidia', 'UNDETERMINED')]).status).toBe('unresolved');
    expect(resolveOutcome(self(), [peer('google', 'TRUE'), peer('nvidia', 'TRUE'), peer('nvidia', 'FALSE', { rater_agent_id: 'r2' })]).status).toBe('unresolved');
  });

  it('an UNDETERMINED self-rating is an abstention, never scored', () => {
    expect(resolveOutcome(self({ self_claim_is: 'UNDETERMINED' }), [peer('google', 'TRUE'), peer('nvidia', 'TRUE')]).status).toBe('abstained');
  });
});

describe('peer calibration: scoring', () => {
  it('Brier, accuracy, gap, overconfidence and coverage over resolved answers only', () => {
    const selfs = [
      self({ task_id: 't1', self_confidence: 0.9 }), // judged correct  -> (0.9-1)^2 = 0.01
      self({ task_id: 't2', self_confidence: 0.9 }), // judged wrong    -> 0.81
      self({ task_id: 't3', self_confidence: 0.6 }), // unresolved      -> not scored
      self({ task_id: 't4', self_claim_is: 'UNDETERMINED', self_confidence: 0.2 }), // abstained
    ];
    const peers = [
      peer('google', 'TRUE', { task_id: 't1' }), peer('nvidia', 'TRUE', { task_id: 't1' }),
      peer('google', 'FALSE', { task_id: 't2' }), peer('nvidia', 'FALSE', { task_id: 't2' }),
      peer('google', 'TRUE', { task_id: 't3' }),
    ];
    const s = summarize(selfs, peers);
    expect(s).toMatchObject({ presented: 4, answered: 3, resolved: 2, coverage: 0.75, accuracy: 0.5, overconfidence_rate: 0.5 });
    expect(s.brier).toBeCloseTo(0.41, 10);
    expect(s.mean_confidence).toBeCloseTo(0.9, 10);
    expect(s.confidence_gap).toBeCloseTo(0.4, 10);
  });

  it('nothing resolved means null scores, not zeros', () => {
    const s = summarize([self()], []);
    expect(s).toMatchObject({ resolved: 0, brier: null, accuracy: null, overconfidence_rate: null, coverage: 1 });
  });

  it('groups by agent and by family', () => {
    const selfs = [self(), self({ agent_id: 'b', family: 'google' })];
    const peers = [peer('google', 'TRUE'), peer('nvidia', 'TRUE'), peer('openai', 'FALSE', { subject_agent_id: 'b' }), peer('nvidia', 'FALSE', { subject_agent_id: 'b' })];
    const byFam = summarizeBy(selfs, peers, (x) => x.family);
    expect(byFam.openai!.accuracy).toBe(1);
    expect(byFam.google!.accuracy).toBe(0);
  });
});

describe('peer calibration: no default is a rating', () => {
  it('parsers return null rather than a default', () => {
    expect(parseClaimIs('true')).toBe('TRUE');
    expect(parseClaimIs('MOSTLY TRUE')).toBeNull();
    expect(parseClaimIs(undefined)).toBeNull();
    expect(parseConfidence01(0.7)).toBe(0.7);
    expect(parseConfidence01('0.7')).toBe(0.7);
    expect(parseConfidence01(85)).toBeNull(); // a percent is not guessed into a probability
    expect(parseConfidence01('')).toBeNull();
    expect(parseConfidence01(undefined)).toBeNull();
    expect(parseConfidence01(NaN)).toBeNull();
  });
});

describe('peer calibration: storage is shadow-only', () => {
  it('the memory store makes a self-rating write-once', async () => {
    const st = new MemoryCalibrationStore();
    await st.saveSelf(self());
    await expect(st.saveSelf(self({ self_confidence: 0.1 }))).rejects.toThrow(/write-once/);
  });

  it('the DB store writes nothing unless CALIBRATION_SHADOW_ENABLED is exactly true, and only its shadow table', async () => {
    const tables: string[] = [];
    const fake = { from: (t: string) => ({ insert: async () => (tables.push(t), {}) }) };
    await new DbCalibrationStore(fake, {}).saveSelf(self());
    await new DbCalibrationStore(fake, { CALIBRATION_SHADOW_ENABLED: '1' }).savePeer(peer('google', 'TRUE'));
    expect(tables).toEqual([]);
    const on = new DbCalibrationStore(fake, { CALIBRATION_SHADOW_ENABLED: 'true' });
    await on.saveSelf(self());
    await on.savePeer(peer('google', 'TRUE'));
    expect(tables).toEqual([CALIBRATION_SHADOW_TABLE, CALIBRATION_SHADOW_TABLE]);
  });
});
