/**
 * lane-a-dryrun.test.ts — the inert Lane A thread (D-145): precommit -> acceptance -> receipt -> would-write
 * experimental shadow row. Proves the chain holds end to end while writing NOTHING, and that it can never claim
 * independence (same_controller only). Teeth: break the satisfaction->verdict collapse and the delta sign flips.
 */
// experimental-repid eagerly imports src/db, whose config loader throws without SUPABASE creds. Factory-mock it.
jest.mock('../../db', () => ({ db: {} }));
import { generateKeyPairSync } from 'node:crypto';
import { runLaneADryRun, satisfactionToVerdict, type LaneADryRunInput } from '../lane-a-dryrun';
import { specWorkStatementHash, parseWorkStatement } from '../../services/work-statement-spec';
import type { SettlementKeys } from '../trusted-settler';

const gen = (): SettlementKeys => { const k = () => generateKeyPairSync('ed25519').privateKey; return { harness: k(), evaluation: k(), settlement: k(), composite: k() }; };
const AGENT = '00000000-0000-0000-0000-000000000abc';

const SPEC = {
  deliverable: 'A 500-word sourced brief on OC recuperative-care discharge options.',
  acceptance_criteria: [
    { n: 1, text: 'Every claimed program includes a verifiable public source URL.' },
    { n: 2, text: 'No eligibility rule is stated that the cited source does not support.' },
  ],
  agreed_price: { amount_usdc_raw: 500000, currency: 'USDC' },
  deadline: '2026-12-01T00:00:00.000Z',
};

const base = (ratings: unknown): LaneADryRunInput => ({
  spec: SPEC,
  ratings,
  contractId: 'contract-abc-123',
  makerAgentId: AGENT,
  deliverableArtifact: 'the produced brief text (data only, hashed, never executed)',
  keys: gen(),
});

describe('Lane A dry-run — inert precommit -> acceptance -> receipt -> would-write (D-145)', () => {
  it('all criteria met -> correct -> would-write +1, verified, same-controller, nothing authoritative', async () => {
    const out = await runLaneADryRun(base([{ n: 1, met: true }, { n: 2, met: true }]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const parsed = parseWorkStatement(SPEC);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(out.work_statement_hash).toBe(specWorkStatementHash(parsed.canonical)); // third-party-recomputable precommit
    expect(out.satisfaction_score).toBe(1);
    expect(out.verified_correct).toBe('correct');
    expect(out.receipt_verified).toBe(true);
    expect(out.receipt_authoritative).toBe(false);              // a demonstration, never a trust anchor
    expect(out.immune_dryrun_status).not.toBe('settled');       // the P0 gate / mode-off: nothing was written
    expect(out.eligibility).toBe('same_controller_measured');   // NEVER independent
    expect(out.experiment_id).toBe('contract-abc-123');         // transitive bind to work_statement_hash
    expect(out.would_write?.delta).toBe(1);
    expect(out.would_write?.domain).toBe('t12-exp-v1');
    expect(out.would_write?.mode).toBe('shadow');
    expect(out.would_write?.eligibility).toBe('same_controller_measured');
  });

  it('a criterion unmet -> satisfaction < threshold -> incorrect -> a LEGITIMATE negative would-write (-1)', async () => {
    const out = await runLaneADryRun(base([{ n: 1, met: true }, { n: 2, met: false }]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.satisfaction_score).toBe(0.5);
    expect(out.verified_correct).toBe('incorrect');
    expect(out.would_write?.delta).toBe(-1);
    expect(out.eligibility).toBe('same_controller_measured');
  });

  it('refuses at the precommit stage on an invalid spec', async () => {
    const out = await runLaneADryRun(base([{ n: 1, met: true }]) as LaneADryRunInput);
    // (ratings cover only n=1 but SPEC has two criteria) -> acceptance stage refusal
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.stage).toBe('acceptance');
  });

  it('refuses a spec with no acceptance criteria at the precommit stage', async () => {
    const bad = { ...base([{ n: 1, met: true }]), spec: { deliverable: 'too short', agreed_price: { amount_usdc_raw: 1, currency: 'USDC' }, deadline: '2026-12-01T00:00:00.000Z', acceptance_criteria: [] } };
    const out = await runLaneADryRun(bad);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.stage).toBe('precommit');
  });

  it('the collapse is a reversible knob: threshold 0.5 would accept a half-met deliverable', () => {
    expect(satisfactionToVerdict(0.5, 1)).toBe('incorrect');
    expect(satisfactionToVerdict(0.5, 0.5)).toBe('correct');
  });
});
