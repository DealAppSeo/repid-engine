/**
 * SERVICE_DELIVERY_CHECK_MODE (services/service-delivery-check.ts, D-170): a SHADOW record of whether
 * a provider's delivery checks out. It replaces P-10's HAL gate, which judged the buyer's input.
 *
 * Two layers: the pure check, and the live writer (applyServiceFulfilledDeltas) with the score-event
 * writer captured. The writer tests are the safety guarantee: off adds no key, and shadow changes no
 * delta and no bridge row.
 */
(global as any).__svcRow = null;
(global as any).__fcImpl = null;
(global as any).__bridgeRows = [];

jest.mock('../../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => ({ hal_score: 0.3, vetoed: false, signals: { comma_severity: null } })),
}));
jest.mock('../../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => (global as any).__fcImpl()),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
  factCheckOptsFromEnv: () => ({ vetoThreshold: 0.5, flagThreshold: 0.35 }),
}));
jest.mock('../../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async () => ({})),
  deriveHalDecision: (score: number, vetoed: boolean) => (vetoed ? 'vetoed' : score >= 0.4 ? 'flagged' : 'clean'),
}));
jest.mock('../../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'service_contracts') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: (global as any).__svcRow, error: null }) }) }) };
      }
      if (table === 'x402_settlements') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { is_simulated: false }, error: null }) }) }) };
      }
      if (table === 'repid_events') {
        return {
          insert: (row: unknown) => {
            (global as any).__bridgeRows.push(row);
            return { select: () => ({ maybeSingle: async () => ({ data: { id: 'ev-1' }, error: null }) }) };
          },
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
  },
}));

import { createHash } from 'crypto';
import { checkDelivery, deliveryCheckMode, halClaimIs } from '../../src/services/service-delivery-check';
import { applyServiceFulfilledDeltas, SERVICE_FULFILLED_DELTAS } from '../../src/services/validation-repid-delta';
import { applyValidationEvent } from '../../src/scoring/pipeline';

const TRUE_CLAIM = 'The Base Sepolia chain id is 84532.';
const FALSE_CLAIM = 'The Base Sepolia chain id is 84533.';
const factChecked = (hal_decision: string, degraded = false) => ({ hal_score: 0.5, hal_decision, hal_signals: { mode: 'fact-check', degraded, providers_used: degraded ? 1 : 3 } });
const verify = (content: string, claim_is: unknown, hal?: any) =>
  checkDelivery({ serviceType: 'verification', payload: { content }, result: { claim_is }, hal });

describe('mode', () => {
  test('unset and off are off; shadow is shadow', () => {
    expect(deliveryCheckMode(undefined)).toBe('off');
    expect(deliveryCheckMode('')).toBe('off');
    expect(deliveryCheckMode(' OFF ')).toBe('off');
    expect(deliveryCheckMode('shadow')).toBe('shadow');
  });
  test('there is no enforce: it and any typo behave as shadow, which changes no number', () => {
    expect(deliveryCheckMode('enforce')).toBe('shadow');
    expect(deliveryCheckMode('shadwo')).toBe('shadow');
  });
});

describe('verification: the chain-id claim has a known answer', () => {
  test('a true claim the provider called TRUE is a correct delivery', () => {
    expect(verify(TRUE_CLAIM, 'TRUE')).toMatchObject({ outcome: 'correct', basis: 'chain_id_constant', truth: 'TRUE', provider_claim_is: 'TRUE' });
  });
  test('a true claim the provider called FALSE is a wrong delivery', () => {
    expect(verify(TRUE_CLAIM, 'FALSE')).toMatchObject({ outcome: 'wrong', truth: 'TRUE' });
  });
  test('a false claim the provider called FALSE is correct: saying "false" is the right answer', () => {
    expect(verify(FALSE_CLAIM, 'FALSE')).toMatchObject({ outcome: 'correct', truth: 'FALSE' });
    expect(verify(FALSE_CLAIM, 'TRUE')).toMatchObject({ outcome: 'wrong', truth: 'FALSE' });
  });
  test('not checked is not failed: UNDETERMINED or a missing claim_is is never "wrong"', () => {
    expect(verify(TRUE_CLAIM, 'UNDETERMINED')).toMatchObject({ outcome: 'not_checked', basis: 'provider_undetermined' });
    expect(verify(TRUE_CLAIM, undefined)).toMatchObject({ outcome: 'not_checked', basis: 'result_has_no_claim_is' });
    expect(verify(TRUE_CLAIM, 'PASS')).toMatchObject({ outcome: 'not_checked', basis: 'result_has_no_claim_is' });
  });
  test('a claim with no known answer is not checked, with both verdicts kept for agreement counts', () => {
    expect(verify('Gold is Au.', 'TRUE', factChecked('vetoed'))).toEqual({
      mode: 'shadow', service_type: 'verification', outcome: 'not_checked', basis: 'no_ground_truth',
      provider_claim_is: 'TRUE', truth: null, hal_claim_is: 'FALSE', hal_correct: null,
    });
  });
});

describe('HAL is scored too, so its error rate is measurable', () => {
  test('the D-170 case: HAL vetoed a TRUE claim; the provider was right and HAL was wrong', () => {
    expect(verify(TRUE_CLAIM, 'TRUE', factChecked('vetoed'))).toMatchObject({ outcome: 'correct', hal_claim_is: 'FALSE', hal_correct: false });
    expect(verify(TRUE_CLAIM, 'TRUE', factChecked('clean'))).toMatchObject({ hal_claim_is: 'TRUE', hal_correct: true });
  });
  test('only a real fact-check counts as HAL answering', () => {
    expect(halClaimIs(undefined)).toBeNull();
    expect(halClaimIs({ hal_score: 0.5, hal_decision: 'clean' })).toBeNull(); // the 0.5/clean placeholder
    expect(halClaimIs(factChecked('clean', true))).toBeNull(); // degraded, incl. the keyword guess
    expect(halClaimIs({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'extractor-fallback' } })).toBeNull();
    expect(halClaimIs({ hal_score: 0.1, hal_decision: 'clean', hal_signals: { mode: 'extractor' } })).toBeNull();
    expect(halClaimIs(factChecked('flagged'))).toBe('UNDETERMINED');
    expect(verify(TRUE_CLAIM, 'TRUE', factChecked('flagged'))).toMatchObject({ hal_claim_is: 'UNDETERMINED', hal_correct: null });
  });
});

describe('storage: the receipt must match the content', () => {
  const content = '{"a":1}';
  const h = createHash('sha256').update(content).digest('hex');
  const good = { content_hash: h, storage_path: `${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`, size_bytes: Buffer.byteLength(content) };
  const store = (result: any, payload: any = { content }) => checkDelivery({ serviceType: 'decentralized_storage', payload, result, hal: undefined });

  test('the right hash, path and size is a correct delivery', () => {
    expect(store(good)).toMatchObject({ outcome: 'correct', basis: 'content_hash' });
  });
  test('a wrong hash, path or size is a wrong delivery', () => {
    expect(store({ ...good, content_hash: 'f'.repeat(64) }).outcome).toBe('wrong');
    expect(store({ ...good, storage_path: 'ab/cd/x' }).outcome).toBe('wrong');
    expect(store({ ...good, size_bytes: 1 }).outcome).toBe('wrong');
  });
  test('binary content is decoded from base64 before hashing', () => {
    const b64 = Buffer.from(content).toString('base64');
    expect(store(good, { content: b64, content_type: 'binary' }).outcome).toBe('correct');
    expect(store(good, { content: b64 }).outcome).toBe('wrong'); // hashed as text, so it differs
  });
  test('no hash in the result, or no content, is not checked', () => {
    expect(store({})).toMatchObject({ outcome: 'not_checked', basis: 'result_has_no_hash' });
    expect(store(good, {})).toMatchObject({ outcome: 'not_checked', basis: 'no_content' });
  });
});

test('any other service type is not checked here (the service-quality hook judges text)', () => {
  expect(checkDelivery({ serviceType: 'fact_check', payload: {}, result: { answer: 'x' }, hal: undefined }))
    .toEqual({ mode: 'shadow', service_type: 'fact_check', outcome: 'not_checked', basis: 'no_deterministic_check' });
});

test('an unexpected shape never throws into the delta path', () => {
  const payload = { get content(): string { throw new Error('boom'); } };
  expect(checkDelivery({ serviceType: 'verification', payload, result: {}, hal: undefined }))
    .toMatchObject({ outcome: 'not_checked', basis: 'check_error' });
});

describe('the live writer', () => {
  const CONTRACT = { id: 'c-1', service_id: 's-1', provider_agent_id: 'prov-1', buyer_agent_id: 'buyer-1' };
  const ENV = ['SERVICE_DELIVERY_CHECK_MODE', 'HAL_ENRICHMENT_ENABLED', 'HAL_STRICTNESS', 'SAME_OWNER_SETTLEMENT_MODE'] as const;
  const saved: Record<string, string | undefined> = {};
  const calls = () => (applyValidationEvent as jest.Mock).mock.calls as any[][];
  const run = async (mode?: string) => {
    if (mode === undefined) delete process.env.SERVICE_DELIVERY_CHECK_MODE; else process.env.SERVICE_DELIVERY_CHECK_MODE = mode;
    (applyValidationEvent as jest.Mock).mockClear();
    (global as any).__bridgeRows = [];
    await applyServiceFulfilledDeltas(CONTRACT);
    return { rows: calls(), bridge: (global as any).__bridgeRows };
  };

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.SAME_OWNER_SETTLEMENT_MODE;
    process.env.HAL_ENRICHMENT_ENABLED = 'true';
    process.env.HAL_STRICTNESS = '2';
    // HAL vetoes the true claim: the shape D-170 found in prod.
    (global as any).__fcImpl = () => ({ hal_score: 0.9, decision: 'vetoed', verdicts: [], providers_used: 3, agreement: 1, degraded: false, latency_ms: 5 });
    (global as any).__svcRow = {
      payload: { content: TRUE_CLAIM, title: 'Task' }, metadata: {}, x402_payment_id: 'pay-1',
      agent_services: { service_type: 'verification' }, result: { claim_is: 'TRUE', verdict: 'PASS' },
    };
  });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('off: no delivery_check key anywhere', async () => {
    const { rows } = await run();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r[3]).not.toHaveProperty('delivery_check');
  });

  test('shadow: the provider row records the check; the buyer row does not', async () => {
    const { rows } = await run('shadow');
    const provider = rows.find((r) => r[3].role === 'provider')!, buyer = rows.find((r) => r[3].role === 'buyer')!;
    expect(provider[3].delivery_check).toMatchObject({ outcome: 'correct', truth: 'TRUE', provider_claim_is: 'TRUE', hal_claim_is: 'FALSE', hal_correct: false });
    expect(buyer[3]).not.toHaveProperty('delivery_check');
  });

  test('shadow changes no number: deltas, HAL verdict and bridge row match off exactly', async () => {
    const off = await run();
    const shadow = await run('shadow');
    expect(shadow.rows.map((r) => r[2])).toEqual(off.rows.map((r) => r[2]));
    expect(shadow.rows.map((r) => r[2])).toEqual([SERVICE_FULFILLED_DELTAS.provider, SERVICE_FULFILLED_DELTAS.buyer]);
    expect(shadow.rows.map((r) => r[4])).toEqual(off.rows.map((r) => r[4]));
    expect(shadow.bridge).toEqual(off.bridge);
    // Even when the check says the delivery is wrong.
    (global as any).__svcRow.result = { claim_is: 'FALSE' };
    const wrong = await run('shadow');
    expect(wrong.rows.find((r) => r[3].role === 'provider')![3].delivery_check.outcome).toBe('wrong');
    expect(wrong.rows.map((r) => r[2])).toEqual(off.rows.map((r) => r[2]));
  });
});
