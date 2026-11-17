/**
 * The per-verdict HAL receipt id (src/hal/verdict-receipt-id.ts) and the HAL_SCORE_GATE_MODE switch
 * (src/scoring/hal-score-gate.ts).
 */
jest.mock('../src/db', () => ({ db: { from: jest.fn() } }));

import { halVerdictReceiptId, halVerdictRecord, withVerdictReceiptId } from '../src/hal/verdict-receipt-id';
import { halScoreGateMode, announceHalScoreGateMode } from '../src/scoring/hal-score-gate';

const TEXT = 'The Eiffel Tower is in Berlin.';
const VETO = {
  decision: 'vetoed',
  hal_score: 0.912345678,
  mode: 'fact-check',
  strictness: 2,
  latency_ms: 812,
  signals: { families_used: 2, families: ['qwen', 'openai'] },
  provider_responses: [
    { provider: 'groq', model: 'gpt-oss', verdict: 'FALSE', confidence: 95, latency_ms: 300 },
    { provider: 'cerebras', model: 'qwen', verdict: 'FALSE', confidence: 90, latency_ms: 500 },
  ],
};

describe('halVerdictReceiptId', () => {
  test('is a stable 256-bit id: same record, same id, whatever the order of families or votes', () => {
    const id = halVerdictReceiptId(TEXT, VETO);
    expect(id).toMatch(/^halv1_[0-9a-f]{64}$/);
    const reordered = { ...VETO, signals: { families_used: 2, families: ['openai', 'qwen'] }, provider_responses: [...VETO.provider_responses].reverse() };
    expect(halVerdictReceiptId(TEXT, reordered)).toBe(id);
  });

  test('ignores latency, confidence and cache markers, so a cached replay keeps the id', () => {
    const replay = { ...VETO, latency_ms: 3, _cached: true, cached: true, provider_responses: VETO.provider_responses.map((v) => ({ ...v, latency_ms: 1, confidence: 1 })) };
    expect(halVerdictReceiptId(TEXT, replay)).toBe(halVerdictReceiptId(TEXT, VETO));
  });

  test.each([
    ['the decision', { ...VETO, decision: 'clean' }, TEXT],
    ['a provider verdict', { ...VETO, provider_responses: [{ provider: 'groq', model: 'gpt-oss', verdict: 'TRUE' }, VETO.provider_responses[1]!] }, TEXT],
    ['the score', { ...VETO, hal_score: 0.5 }, TEXT],
    ['the mode', { ...VETO, mode: 'extractor-fallback' }, TEXT],
    ['the judged text', VETO, 'The Eiffel Tower is in Paris.'],
  ])('changes when %s changes', (_what, v, text) => {
    expect(halVerdictReceiptId(text, v)).not.toBe(halVerdictReceiptId(TEXT, VETO));
  });

  test('the record carries a hash of the text, never the text', () => {
    const rec = halVerdictRecord(TEXT, VETO);
    expect(JSON.stringify(rec)).not.toContain('Eiffel');
    expect(rec.text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.quorum_met).toBe(true);
  });
});

describe('withVerdictReceiptId (POST /api/v1/hal/evaluate)', () => {
  const saved = process.env.HAL_VERDICT_RECEIPT_ID_ENABLED;
  afterEach(() => { if (saved === undefined) delete process.env.HAL_VERDICT_RECEIPT_ID_ENABLED; else process.env.HAL_VERDICT_RECEIPT_ID_ENABLED = saved; });

  test.each([[undefined], ['1'], ['on'], ['TRUE']])('flag %s: the body is returned unchanged (same object)', (v) => {
    if (v === undefined) delete process.env.HAL_VERDICT_RECEIPT_ID_ENABLED; else process.env.HAL_VERDICT_RECEIPT_ID_ENABLED = v;
    expect(withVerdictReceiptId(TEXT, VETO)).toBe(VETO);
  });

  test("flag exactly 'true': the body gains receipt_id and nothing else changes", () => {
    process.env.HAL_VERDICT_RECEIPT_ID_ENABLED = 'true';
    const out = withVerdictReceiptId(TEXT, VETO) as typeof VETO & { receipt_id: string };
    expect(out.receipt_id).toBe(halVerdictReceiptId(TEXT, VETO));
    const { receipt_id: _r, ...rest } = out;
    expect(rest).toEqual(VETO);
  });
});

describe('HAL_SCORE_GATE_MODE', () => {
  test.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['OFF', 'off'], ['bogus', 'off'], ['1', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'],
    ['enforce', 'shadow'], ['ENFORCE', 'shadow'],
  ])('%s resolves to %s (enforce is refused down to shadow)', (raw, want) => {
    expect(halScoreGateMode(raw)).toBe(want);
  });

  test('enforce is refused LOUDLY at boot; an unknown value is loud too; off/shadow are a plain line', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    announceHalScoreGateMode('enforce');
    expect(String(err.mock.calls[0]?.[0])).toMatch(/HAL_SCORE_GATE_MODE=enforce REFUSED.*Running as 'shadow'/);
    announceHalScoreGateMode('enforec');
    expect(String(err.mock.calls[1]?.[0])).toMatch(/'enforec' is not off\|shadow\|enforce\. Resolved to 'off'/);
    announceHalScoreGateMode(undefined);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/resolved to 'off'/);
    err.mockRestore(); log.mockRestore();
  });
});
