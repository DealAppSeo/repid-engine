/**
 * receipt-store.test.ts — M2 persistence is append-only, inert by default, and can NEVER make a receipt
 * authoritative; an exported bundle re-verifies without the DB. Receipts come from the REAL producer
 * (runTrustedSettlement), so the test exercises the actual combined-receipt shape, not a hand-built stub.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runTrustedSettlement, fixtureOracle, trustRootsFor, type SettlementKeys } from '../trusted-settler';
import {
  buildReceiptRecord,
  recordReceipt,
  currentState,
  verifyEvidenceBundle,
  type ImmuneReceiptEvent,
} from '../receipt-store';
import type { SignedCombinedReceipt, CombinedReceiptTrustRoots } from '../combined-receipt';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const gen = (): SettlementKeys => {
  const k = () => generateKeyPairSync('ed25519').privateKey;
  return { harness: k(), evaluation: k(), settlement: k(), composite: k() };
};

/** A real, valid signed combined receipt (correct or incorrect) + its verification + trust roots. */
function makeReceipt(result: 'correct' | 'incorrect' = 'correct'): {
  receipt: SignedCombinedReceipt; verification: { ok: boolean; reasons: string[]; authoritative: boolean }; roots: CombinedReceiptTrustRoots;
} {
  const keys = gen();
  const oracle = fixtureOracle([{ id: 'c1', claim: 'the claim', expected: 'TRUE' }]);
  const verdict = JSON.stringify({ id: 'c1', verdict: result === 'correct' ? 'TRUE' : 'FALSE' });
  const verdict_sha256 = '0x' + sha256hex(verdict);
  const res = runTrustedSettlement({
    bundle: { verdict, verdict_sha256, sandbox_receipt: { mission_id: 'm-1', airlock_decision: 'promote', artifact_sha256: verdict_sha256, profile_checks: [{ name: 'contained', passed: true }] } },
    oracle,
    keys,
    context: { experiment_id: `exp-${result}`, claim_id: 'c1', maker_id: 'maker', maker_controller: 'ctrl', checker_id: 'oracle', checker_controller: 'ctrl' },
  });
  if (!res.ok) throw new Error('fixture settlement refused: ' + res.refused.join(','));
  return { receipt: res.receipt, verification: res.verification, roots: trustRootsFor(keys) };
}

describe('receipt-store — append-only evidence + lifecycle, inert, no laundering', () => {
  it('buildReceiptRecord maps the bindings off the signed receipt', () => {
    const { receipt } = makeReceipt('correct');
    const rec = buildReceiptRecord(receipt);
    expect(rec.content_hash).toBe(receipt.content_hash);
    expect(rec.result).toBe('correct');
    expect(rec.experiment_id).toBe('exp-correct');
    expect(rec.mission_id).toBe('m-1');
    expect(rec.artifact_hash).toBe(receipt.artifact_hash);
    expect(rec.independence_class).toBe(receipt.independence_class);
    expect(rec.receipt).toBe(receipt);
  });

  it('is INERT by default: disabled ⇒ dry-run, the writer is never called', () => {
    const { receipt, verification } = makeReceipt();
    let called = 0;
    const r = recordReceipt(receipt, verification, { enabled: false, writeFn: () => { called++; } });
    expect(r.persisted).toBe(false);
    expect(called).toBe(0);
    expect(r.events?.map((e) => e.event_type)).toEqual(['recorded', 'outcome_verified']);
  });

  it('enabled + writer persists; a verified receipt gets recorded + outcome_verified', () => {
    const { receipt, verification } = makeReceipt();
    const written: { events: ImmuneReceiptEvent[] }[] = [];
    const r = recordReceipt(receipt, verification, { enabled: true, writeFn: (_rec, events) => written.push({ events }) });
    expect(r.persisted).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]!.events.map((e) => e.event_type)).toEqual(['recorded', 'outcome_verified']);
  });

  it('PRESERVES a failed receipt as evidence: recorded + verification_failed, never outcome_verified', () => {
    const { receipt } = makeReceipt();
    const r = recordReceipt(receipt, { ok: false, reasons: ['signature_invalid'], authoritative: false }, { enabled: true, writeFn: () => {} });
    const types = r.events!.map((e) => e.event_type);
    expect(types).toContain('recorded');
    expect(types).toContain('verification_failed');
    expect(types).not.toContain('outcome_verified');
    expect(r.events!.find((e) => e.event_type === 'verification_failed')!.event_data).toEqual({ reasons: ['signature_invalid'] });
  });

  it('NEVER emits an authoritative event — persistence cannot launder authority (the core M2 guarantee)', () => {
    const { receipt, verification } = makeReceipt();
    const r = recordReceipt(receipt, verification, { enabled: true, writeFn: () => {} });
    const types = r.events!.map((e) => e.event_type);
    expect(types).not.toContain('origin_authenticated');
    expect(types).not.toContain('settled');
    expect(types).not.toContain('anchored');
    expect(currentState(r.events!).is_authoritative).toBe(false);
  });

  it('refuses a malformed receipt (not evidence)', () => {
    const r = recordReceipt(null as unknown as SignedCombinedReceipt, { ok: true, reasons: [], authoritative: true });
    expect(r.persisted).toBe(false);
    expect(r.refused).toEqual(['receipt_malformed']);
  });

  it('currentState derives is_authoritative only from an origin_authenticated event, and a revoke drops it', () => {
    const h = 'abc';
    const base: ImmuneReceiptEvent[] = [{ content_hash: h, event_type: 'recorded', event_data: null, actor: 'x' }, { content_hash: h, event_type: 'outcome_verified', event_data: null, actor: 'x' }];
    expect(currentState(base).is_authoritative).toBe(false);
    const authed = [...base, { content_hash: h, event_type: 'origin_authenticated' as const, event_data: null, actor: 'engine' }];
    expect(currentState(authed).is_authoritative).toBe(true);
    const revoked = [...authed, { content_hash: h, event_type: 'revoked' as const, event_data: null, actor: 'engine' }];
    expect(currentState(revoked).is_authoritative).toBe(false);
  });
});

describe('verifyEvidenceBundle — re-validate an exported bundle without trusting the DB', () => {
  it('validates a real recorded bundle (valid, not authoritative)', () => {
    const { receipt, verification, roots } = makeReceipt();
    const { events } = recordReceipt(receipt, verification, { enabled: false });
    const v = verifyEvidenceBundle({ receipt, events }, roots);
    expect(v.valid).toBe(true);
    expect(v.state.is_recorded).toBe(true);
    expect(v.state.is_authoritative).toBe(false);
  });

  it('catches a receipt tampered after recording (content hash + crypto)', () => {
    const { receipt, verification, roots } = makeReceipt();
    const { events } = recordReceipt(receipt, verification, { enabled: false });
    const tampered = { ...receipt, result: 'incorrect' as const }; // flip the headline, keep the old hash/signature
    const v = verifyEvidenceBundle({ receipt: tampered, events }, roots);
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain('content_hash_tampered');
  });

  it('rejects an illegitimate state ordering (settled without verification, anchored without authority)', () => {
    const { receipt, verification, roots } = makeReceipt();
    const h = receipt.content_hash;
    const forgedEvents: ImmuneReceiptEvent[] = [
      { content_hash: h, event_type: 'recorded', event_data: null, actor: 'x' },
      { content_hash: h, event_type: 'settled', event_data: null, actor: 'x' },  // but never outcome_verified
      { content_hash: h, event_type: 'anchored', event_data: null, actor: 'x' }, // and never origin_authenticated
    ];
    const v = verifyEvidenceBundle({ receipt, events: forgedEvents }, roots);
    expect(v.valid).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(['settled_without_verification', 'anchored_without_authority']));
  });

  it('rejects events that belong to a different receipt', () => {
    const { receipt, verification, roots } = makeReceipt();
    const { events } = recordReceipt(receipt, verification, { enabled: false });
    const mixed = [...events!, { content_hash: 'some-other-hash', event_type: 'settled' as const, event_data: null, actor: 'x' }];
    const v = verifyEvidenceBundle({ receipt, events: mixed }, roots);
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain('event_hash_mismatch');
  });
});
