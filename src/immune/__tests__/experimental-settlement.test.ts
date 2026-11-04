/**
 * experimental-settlement.test.ts — M3 (a): only a VERIFIED + AUTHORITATIVE immune receipt moves experimental
 * reputation, into the clean repid_experimental_events path, inert by default. A real receipt is built via the
 * settler, then re-signed as authoritative (simulating the engine) so the P0 gate is exercised against real shapes.
 */
// experimental-repid eagerly imports src/db, whose config loader throws without SUPABASE creds at module load.
// A FACTORY mock avoids loading the real module (production/engine has the creds); nothing here touches the db.
jest.mock('../../db', () => ({ db: {} }));
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runTrustedSettlement, fixtureOracle, trustRootsFor, type SettlementKeys } from '../trusted-settler';
import { buildCombinedReceipt, signCombinedReceipt, verifyCombinedReceipt, type SignedCombinedReceipt, type CombinedReceiptInput } from '../combined-receipt';
import { settleImmuneReceipt, IMMUNE_EVIDENCE_KIND, IMMUNE_DIMENSION } from '../experimental-settlement';
import type { ExperimentalStore, ExperimentalEventRow } from '../../services/experimental-repid';

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const gen = (): SettlementKeys => { const k = () => generateKeyPairSync('ed25519').privateKey; return { harness: k(), evaluation: k(), settlement: k(), composite: k() }; };
const AGENT = '00000000-0000-0000-0000-000000000abc';
const CP = '00000000-0000-0000-0000-0000000000ff';
const ALPHA_SQUAD = '550e8400-e29b-41d4-a716-446655440001'; // Matthew (designated)
const BETA_SQUAD = '550e8400-e29b-41d4-a716-446655440002';  // Mark (designated)
/** inject a fixed owner verdict (the real DB owner check is mocked in these tests). */
const independenceReturning = (v: 'independent' | 'same_owner' | 'owner_unknown') =>
  (async () => v) as unknown as Parameters<typeof settleImmuneReceipt>[1]['independence'];

/** A valid signed receipt (correct|incorrect) from the settler, plus its keys (authoritative:false as the settler emits). */
function settled(result: 'correct' | 'incorrect', keys: SettlementKeys = gen()) {
  const oracle = fixtureOracle([{ id: 'c1', claim: 'x', expected: 'TRUE' }]);
  const verdict = JSON.stringify({ id: 'c1', verdict: result === 'correct' ? 'TRUE' : 'FALSE' });
  const res = runTrustedSettlement({
    bundle: { verdict, verdict_sha256: '0x' + sha256hex(verdict), sandbox_receipt: { mission_id: 'm1', airlock_decision: 'promote', artifact_sha256: '0x' + sha256hex(verdict), profile_checks: [{ name: 'c', passed: true }] } },
    oracle, keys,
    context: { experiment_id: `exp-${result}`, claim_id: 'c1', maker_id: AGENT, maker_controller: 'ctrl', checker_id: 'oracle-fixture', checker_controller: 'ctrl' },
  });
  if (!res.ok) throw new Error('fixture refused: ' + res.refused.join(','));
  return { res, keys };
}

/** Re-sign the settler's body as AUTHORITATIVE (what the protected engine would do once origin is authenticated). */
function authoritativeReceipt(result: 'correct' | 'incorrect' = 'correct') {
  const { res, keys } = settled(result);
  const { content_hash: _c, signer: _s, signature: _g, schema: _sc, ...body } = res.receipt as unknown as Record<string, unknown>;
  const receipt = signCombinedReceipt(buildCombinedReceipt({ ...(body as unknown as CombinedReceiptInput), authoritative: true }), keys.composite);
  const verification = verifyCombinedReceipt(receipt, trustRootsFor(keys));
  return { receipt, verification, agentId: AGENT };
}

function mockStore(opts: { duplicate?: boolean; score_after?: number } = {}): { store: ExperimentalStore; rows: ExperimentalEventRow[] } {
  const rows: ExperimentalEventRow[] = [];
  return {
    rows,
    store: {
      async getAgent() { return { id: AGENT, agent_id: AGENT, agent_name: 'a' }; },
      async insert(row) { rows.push(row); return opts.duplicate ? { ok: false, duplicate: true, error: 'dup' } : { ok: true, score_after: opts.score_after ?? 42 }; },
    },
  };
}

describe('immune experimental settlement — verified+authoritative only, inert (M3)', () => {
  it('refuses a NON-authoritative receipt (the P0 gate) even with mode on + store', async () => {
    const { res } = settled('correct'); // settler emits authoritative:false
    const { store, rows } = mockStore();
    const out = await settleImmuneReceipt({ receipt: res.receipt, verification: res.verification, agentId: AGENT }, { store, mode: 'shadow', enabled: true });
    expect(out.status).toBe('not_authoritative');
    expect(rows).toHaveLength(0);
  });

  it('refuses an unverified receipt', async () => {
    const { receipt } = authoritativeReceipt();
    const out = await settleImmuneReceipt({ receipt, verification: { ok: false, reasons: ['signature_invalid'], authoritative: true }, agentId: AGENT }, { mode: 'shadow', enabled: true });
    expect(out.status).toBe('unverified');
  });

  it('mode off ⇒ off (settles nothing)', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt();
    const out = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'off', enabled: true, store: mockStore().store });
    expect(out.status).toBe('off');
  });

  it('authoritative + shadow + flag OFF ⇒ dry-run with a correctly shaped row (no write)', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const { store, rows } = mockStore();
    const out = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'shadow', enabled: false, store });
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(rows).toHaveLength(0);
    expect(out.row.domain).toBe('t12-exp-v1');
    expect(out.row.dimension).toBe(IMMUNE_DIMENSION);
    expect(out.row.evidence_kind).toBe(IMMUNE_EVIDENCE_KIND);
    expect(out.row.delta).toBe(1);
    expect(out.row.eligibility).toBe('same_controller_measured');
    expect(out.row.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.row.mode).toBe('shadow');
  });

  it('a verified-INCORRECT receipt settles a LEGITIMATE negative delta', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('incorrect');
    const out = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'shadow', enabled: false });
    expect(out.status).toBe('dry_run');
    if (out.status === 'dry_run') expect(out.row.delta).toBe(-1);
  });

  it('enabled + store ⇒ settled; a duplicate ⇒ already_consumed (one-time)', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const ok = mockStore({ score_after: 7 });
    const s = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'shadow', enabled: true, store: ok.store });
    expect(s.status).toBe('settled');
    if (s.status === 'settled') { expect(s.delta).toBe(1); expect(s.score_after).toBe(7); }
    expect(ok.rows).toHaveLength(1);

    const dup = mockStore({ duplicate: true });
    const again = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'shadow', enabled: true, store: dup.store });
    expect(again.status).toBe('refused');
    if (again.status === 'refused') expect(again.reason).toBe('already_consumed');
  });

  it('refuses self-dealing (the oracle is the subject)', async () => {
    const { receipt, verification } = authoritativeReceipt('correct');
    const out = await settleImmuneReceipt({ receipt, verification, agentId: receipt.ruler.oracle_set_id }, { mode: 'shadow', enabled: true, store: mockStore().store });
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.reason).toBe('self_dealing');
  });

  it('independence is DERIVED, not trusted: a distinct independent counterparty ⇒ independent_counterparty', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const independentFn = (async () => 'independent') as unknown as Parameters<typeof settleImmuneReceipt>[1]['independence'];
    const out = await settleImmuneReceipt({ receipt, verification, agentId, counterpartyAgentId: '00000000-0000-0000-0000-0000000000ff' }, { mode: 'shadow', enabled: false, independence: independentFn });
    expect(out.status).toBe('dry_run');
    if (out.status === 'dry_run') {
      expect(out.row.eligibility).toBe('independent_counterparty');
      expect(out.row.counterparty_agent_id).toBe('00000000-0000-0000-0000-0000000000ff');
    }
  });

  // OWNER-ASSURANCE — the squad designation is recorded as an HONEST tag and NEVER launders eligibility.
  it('owner-assurance: a DESIGNATED pair is tagged designated but is NEVER the evidence independent_counterparty', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const out = await settleImmuneReceipt(
      { receipt, verification, agentId, counterpartyAgentId: CP, squads: { maker: ALPHA_SQUAD, counterparty: BETA_SQUAD } },
      { mode: 'shadow', enabled: false, independence: independenceReturning('owner_unknown') },
    );
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(out.row.metadata.owner_assurance).toBe('designated');        // honestly flagged for the experiment
    expect(out.row.eligibility).toBe('same_controller_measured');       // but the award path is NOT independent
    expect(out.row.counterparty_agent_id).toBeNull();                   // and no award counterparty is recorded
  });

  it('owner-assurance: a real same_owner pair is NEVER laundered by a designation (none)', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const out = await settleImmuneReceipt(
      { receipt, verification, agentId, counterpartyAgentId: CP, squads: { maker: ALPHA_SQUAD, counterparty: BETA_SQUAD } },
      { mode: 'shadow', enabled: false, independence: independenceReturning('same_owner') },
    );
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(out.row.metadata.owner_assurance).toBe('none');
    expect(out.row.metadata.owner_assurance_reason).toBe('same_real_owner');
    expect(out.row.eligibility).toBe('same_controller_measured');
  });

  it('owner-assurance: evidence-independent ⇒ verified AND independent_counterparty (the only path to verified)', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const out = await settleImmuneReceipt(
      { receipt, verification, agentId, counterpartyAgentId: CP, squads: { maker: ALPHA_SQUAD, counterparty: BETA_SQUAD } },
      { mode: 'shadow', enabled: false, independence: independenceReturning('independent') },
    );
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(out.row.metadata.owner_assurance).toBe('verified');
    expect(out.row.eligibility).toBe('independent_counterparty');
  });

  it('owner-assurance: no counterparty / no squads ⇒ none', async () => {
    const { receipt, verification, agentId } = authoritativeReceipt('correct');
    const out = await settleImmuneReceipt({ receipt, verification, agentId }, { mode: 'shadow', enabled: false });
    expect(out.status).toBe('dry_run');
    if (out.status !== 'dry_run') return;
    expect(out.row.metadata.owner_assurance).toBe('none');
    expect(out.row.metadata.owner_assurance_reason).toBe('owner_unknown_undesignated');
  });
});
