/**
 * Tests for receipt-issuer pure JSON construction. The persistence path
 * (issueReceipt → DB) is exercised separately at integration-test time.
 *
 * v1.0 acceptance: receiptJson conforms to hyperdag-protocol/schemas/receipt.v1.json.
 * Until ajv is added as a dependency, validation is performed by checking
 * required fields and bytes32 patterns against the schema definition.
 */
import { buildReceiptJson, canonicalize, keccakOfCanonicalJson } from '../src/services/receipt-issuer';
import type { HALOutputForReceipt } from '../src/services/receipt-issuer';
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'hyperdag-protocol',
  'schemas',
  'receipt.v1.json',
);

const HEX32 = /^0x[a-fA-F0-9]{64}$/;

function sampleInput(overrides: Partial<Parameters<typeof buildReceiptJson>[0]> = {}) {
  const halOutput: HALOutputForReceipt = {
    signals: {
      harm_probability: 0.1,
      epistemic_uncertainty: 0.2,
      evidence_quality: 0.7,
      scope_appropriateness: 0.8,
      certainty_at_claim: 0.85,
      agreement_score: 0.9,
      prompt_category: 'factual',
      comma_veto: false,
      comma_gap: 0.001,
      comma_severity: 'none',
    },
    hal_score: 0.213,
    vetoed: false,
    veto_reason: null,
    veto_threshold: 0.43,
    comma_veto: false,
    comma_gap: 0.001,
    comma_severity: 'none',
    formula: '6-DOF',
  };
  return {
    agentId: 42,
    agentWallet: '0x1234567890123456789012345678901234567890',
    x402PaymentProof: {
      network: 'base-sepolia',
      currency: 'USDC',
      amount: '1000000',
      resourceUri: 'https://example.test/resource/1',
    },
    taskInput: { prompt: 'analyze CRE deal' },
    taskResult: { answer: 'class B office, 6.2% cap' },
    halOutput,
    repIdCommitment: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    scoreVersion: 6,
    reputationScore: 1234,
    reputationConfidence: 0.92,
    ...overrides,
  };
}

describe('canonicalize', () => {
  it('produces deterministic output regardless of key order', () => {
    expect(canonicalize({ b: 2, a: 1 })).toEqual(canonicalize({ a: 1, b: 2 }));
  });
  it('handles nested objects', () => {
    const a = canonicalize({ x: { b: [3, 1], a: 2 } });
    const b = canonicalize({ x: { a: 2, b: [3, 1] } });
    expect(a).toEqual(b);
  });
  it('does not sort array elements', () => {
    expect(canonicalize([2, 1])).not.toEqual(canonicalize([1, 2]));
  });
});

describe('keccakOfCanonicalJson', () => {
  it('returns a 0x-prefixed 32-byte hash', () => {
    const h = keccakOfCanonicalJson({ a: 1 });
    expect(h).toMatch(HEX32);
  });
  it('is stable across key reordering', () => {
    expect(keccakOfCanonicalJson({ a: 1, b: 2 })).toEqual(keccakOfCanonicalJson({ b: 2, a: 1 }));
  });
});

describe('buildReceiptJson — schema conformance', () => {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));

  it('produces a receipt JSON with all top-level required fields from schema', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    for (const field of schema.required as string[]) {
      expect(receiptJson).toHaveProperty(field);
    }
  });

  it('receiptId is a bytes32 hex string', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    expect(receiptJson.receiptId).toMatch(HEX32);
  });

  it('agent block has required ERC-8004 fields', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    const agent = receiptJson.agent as Record<string, string>;
    expect(agent.standard).toBe('ERC-8004');
    expect(agent.agentRegistry).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(agent.agentId).toMatch(/^[0-9]+$/);
    expect(agent.agentWallet).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('payment block has required x402 fields and bytes32 hashes', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    const payment = receiptJson.payment as Record<string, string>;
    expect(payment.standard).toBe('x402');
    expect(payment.paymentHash).toMatch(HEX32);
    expect(payment.resourceHash).toMatch(HEX32);
  });

  it('hal block carries dofVersion 5 or 6 and the Pythagorean constant', () => {
    const r5 = buildReceiptJson(sampleInput({ scoreVersion: 5 })).receiptJson.hal as Record<string, unknown>;
    expect(r5.dofVersion).toBe(5);
    expect(r5.pythagoreanCommaConstant).toBe('531441/524288');
    const r6 = buildReceiptJson(sampleInput({ scoreVersion: 6 })).receiptJson.hal as Record<string, unknown>;
    expect(r6.dofVersion).toBe(6);
  });

  it('commaBftVerdict reflects HAL output (pass / veto / indeterminate)', () => {
    const passInput = sampleInput();
    expect((buildReceiptJson(passInput).receiptJson.hal as any).commaBftVerdict).toBe('pass');

    const vetoInput = sampleInput();
    vetoInput.halOutput.comma_veto = true;
    expect((buildReceiptJson(vetoInput).receiptJson.hal as any).commaBftVerdict).toBe('veto');

    const indetInput = sampleInput();
    indetInput.halOutput.signals.agreement_score = null;
    expect((buildReceiptJson(indetInput).receiptJson.hal as any).commaBftVerdict).toBe('indeterminate');
  });

  it('validators array has at least one primary entry by default', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    const validators = receiptJson.validators as Array<Record<string, string>>;
    expect(validators.length).toBeGreaterThanOrEqual(1);
    expect(validators[0].role).toBe('primary');
  });

  it('privacy.mode defaults to commitment-only in v1.0', () => {
    const { receiptJson } = buildReceiptJson(sampleInput());
    expect((receiptJson.privacy as any).mode).toBe('commitment-only');
  });

  it('rejects unsupported scoreVersion', () => {
    expect(() => buildReceiptJson(sampleInput({ scoreVersion: 7 as any }))).toThrow();
  });
});
