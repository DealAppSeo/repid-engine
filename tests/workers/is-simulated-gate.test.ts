/**
 * F-series patch regression — is_simulated gate + MOCK_TX_RE normalization.
 *
 * Mirrors the ATTACKER F-series variant matrix (CC2_ATTACKER_F_SERIES_RESULTS.md):
 * every truthy variant (incl. case/type/nested) MUST be caught; every falsy
 * variant MUST pass the sim gate. JS layer (isEligibleForOnChainWrite) +
 * normalizer units + MOCK_TX_RE case-insensitivity + SQL-fragment shape.
 * (Live SQL execution is verified separately via the deterministic probe.)
 */
import { isTruthyFlag, hasTruthySimFlag } from '../../src/utils/truthy';
import {
  isEligibleForOnChainWrite,
  MOCK_TX_RE,
  POLL_EVENT_FILTER_SQL,
} from '../../src/workers/feedback-loop-filters';

const UUID = '11111111-2222-4333-8444-555555555555';
const ev = (event_data: any) => ({ subject_type: 'agent', subject_id: UUID, event_data });

// value, expectedTruthy
const SCALARS: [string, unknown, boolean][] = [
  ['bool true', true, true],
  ['"true"', 'true', true],
  ['"True"', 'True', true],          // F1
  ['"TRUE"', 'TRUE', true],          // F1
  ['int 1', 1, true],                // F2
  ['"1"', '1', true],                // F2
  ['"yes"', 'yes', true],            // F2
  ['"YES"', 'YES', true],
  ['"  true  " (ws)', '  true  ', true],
  ['bool false', false, false],
  ['"false"', 'false', false],
  ['int 0', 0, false],
  ['"0"', '0', false],
  ['"no"', 'no', false],
  ['null', null, false],
  ['undefined', undefined, false],
  ['empty ""', '', false],
];

describe('isTruthyFlag (scalar normalizer)', () => {
  test.each(SCALARS)('%s -> %p', (_label, value, expected) => {
    expect(isTruthyFlag(value)).toBe(expected);
  });
});

describe('hasTruthySimFlag (object-aware, incl. nested F4)', () => {
  test.each(SCALARS)('{is_simulated: %s}', (_label, value, expected) => {
    expect(hasTruthySimFlag({ is_simulated: value })).toBe(expected);
  });
  test('nested flags.is_simulated:true -> true (F4)', () => {
    expect(hasTruthySimFlag({ flags: { is_simulated: true } })).toBe(true);
  });
  test('nested metadata.is_simulated:"True" -> true (F1+F4)', () => {
    expect(hasTruthySimFlag({ metadata: { is_simulated: 'True' } })).toBe(true);
  });
  test('no flag anywhere -> false', () => {
    expect(hasTruthySimFlag({ tx_hash: '0x1234', metadata: { contract_id: 'c' } })).toBe(false);
  });
  test('null / non-object -> false', () => {
    expect(hasTruthySimFlag(null)).toBe(false);
    expect(hasTruthySimFlag(undefined)).toBe(false);
    expect(hasTruthySimFlag('x')).toBe(false);
  });
});

describe('isEligibleForOnChainWrite — sim gate (JS layer)', () => {
  // Truthy variants (incl nested) MUST be blocked at the is_simulated gate.
  const TRUTHY: [string, any][] = [
    ['bool true', { is_simulated: true }],
    ['"true"', { is_simulated: 'true' }],
    ['"True" (F1)', { is_simulated: 'True' }],
    ['"TRUE" (F1)', { is_simulated: 'TRUE' }],
    ['int 1 (F2)', { is_simulated: 1 }],
    ['"1" (F2)', { is_simulated: '1' }],
    ['"yes" (F2)', { is_simulated: 'yes' }],
    ['nested (F4)', { flags: { is_simulated: true } }],
  ];
  test.each(TRUTHY)('%s -> BLOCKED (eligible=false, is_simulated)', (_label, ed) => {
    const r = isEligibleForOnChainWrite(ev(ed));
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('is_simulated');
  });

  // Falsy variants pass the sim gate (eligible — real contract).
  const FALSY: [string, any][] = [
    ['bool false', { is_simulated: false }],
    ['"false"', { is_simulated: 'false' }],
    ['int 0', { is_simulated: 0 }],
    ['"no"', { is_simulated: 'no' }],
    ['null', { is_simulated: null }],
    ['absent', {}],
  ];
  test.each(FALSY)('%s -> eligible (real contract)', (_label, ed) => {
    expect(isEligibleForOnChainWrite(ev(ed)).eligible).toBe(true);
  });
});

describe('MOCK_TX_RE — case-insensitive (F5)', () => {
  test.each(['0xmock1234', '0xMOCK1234', '0xMock1234', '0xabc12345', '0xABC12345', '0x00000000aa'])(
    '%s -> matches mock prefix',
    (h) => expect(MOCK_TX_RE.test(h)).toBe(true)
  );
  test.each(['0x1234567890', '0xdeadbeef00', ''])('%s -> NOT mock', (h) =>
    expect(MOCK_TX_RE.test(h)).toBe(false)
  );
  test('mock tx routes to mock_tx_hash reason via filter', () => {
    const r = isEligibleForOnChainWrite(ev({ is_simulated: false, tx_hash: '0xMOCKdeadbeef' }));
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('mock_tx_hash');
  });
});

describe('POLL_EVENT_FILTER_SQL — normalized shape (mirrors JS)', () => {
  test('is_simulated uses lower(...) NOT IN (true,1,yes)', () => {
    expect(POLL_EVENT_FILTER_SQL).toContain("lower(COALESCE(event_data->>'is_simulated', 'false')) NOT IN ('true', '1', 'yes')");
  });
  test('tx_hash uses case-insensitive !~*', () => {
    expect(POLL_EVENT_FILTER_SQL).toContain("!~* '^0x(mock|abc|0{8})'");
  });
});
