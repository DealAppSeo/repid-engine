/**
 * The deterministic verify leg over LABELED known-answer replies (synthetic ids; no row is copied from any
 * database). Pins the measured property that gates shadow -> enforce: a key-free structural contract grades
 * FORM, not CORRECTNESS. A well-formed wrong answer is `approved` (a false positive against a correctness
 * label), so `enforce` must not be read as "the answer was right".
 *
 * Label rule: POSITIVE iff decision is pass|veto AND equals the answer key; else NEGATIVE.
 * Predicted positive: verifier_verdict === 'approved'.
 */
import { verifyTaskDeterministically } from '../src/services/task-verify-leg';

const STRUCTURAL = JSON.stringify({ matches: '"decision"\\s*:\\s*"(pass|veto)"', json_keys: ['decision', 'confidence', 'reason'] });
const reply = (decision: string, confidence = 0.9) => JSON.stringify({ decision, confidence, reason: 'synthetic' });

const CASES: { id: string; key: 'pass' | 'veto'; result: string; label: boolean; approved: boolean }[] = [
  { id: 'syn-right-pass', key: 'pass', result: reply('pass'), label: true, approved: true },
  { id: 'syn-right-veto', key: 'veto', result: reply('veto'), label: true, approved: true },
  { id: 'syn-wrong-veto', key: 'pass', result: reply('veto'), label: false, approved: true }, // FALSE POSITIVE, by design of a key-free contract
  { id: 'syn-abstain', key: 'pass', result: reply('abstain', 0.4), label: false, approved: false },
  { id: 'syn-unparseable', key: 'veto', result: 'veto, probably', label: false, approved: false },
  { id: 'syn-placeholder', key: 'pass', result: JSON.stringify({ decision: 'pass', confidence: 0.9, reason: 'TBD' }), label: true, approved: false }, // FALSE NEGATIVE: right answer, placeholder word in the reason
];

describe('verify leg vs a correctness label', () => {
  it.each(CASES)('$id', async (c) => {
    const leg = await verifyTaskDeterministically({ expected_output: STRUCTURAL, result: c.result });
    expect(leg).not.toBeNull();
    expect(leg!.verifier_verdict === 'approved').toBe(c.approved);
  });

  it('a row with no contract is not graded at all (what every sampled prod row carries)', async () => {
    expect(await verifyTaskDeterministically({ expected_output: null, result: reply('veto') })).toBeNull();
  });
});
