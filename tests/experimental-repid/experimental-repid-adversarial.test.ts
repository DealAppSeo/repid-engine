/**
 * experimental-repid-adversarial.test.ts — the owner-independence priorities worked as attacks.
 *
 * Each describe is ONE adversarial move against the experimental RepID namespace (t12-exp-v1).
 * The existing suites (experimental-repid.test.ts, immune/experimental-settlement.test.ts) already
 * prove the happy path and the core refusals; this file targets the gaps those miss and, per
 * LESSONS 5, every attack carries a POSITIVE CONTROL — the same instrument returning the OTHER
 * answer — so a green run is a measurement, not a vacuous pass.
 *
 * FINDING [V 2026-11-07, by running these]: all six priorities are refused by code already on
 * main. Nothing here adds a guard or new scoring math; it pins the guards and the honest cross-mode
 * ledger semantics so a later change that weakens them turns red. Inert: no DB, no network, the
 * Supabase client is the same in-memory fake the sibling suite uses; the mode is never 'active'
 * against a real store.
 */
import {
  EXPERIMENTAL_DOMAIN,
  EXPERIMENTAL_LABEL,
  eligibilityFor,
  experimentalTier,
  knownAnswerEvidence,
  sealEvidence,
  settleExperimental,
  supabaseExperimentalStore,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';
import { partyIndependence } from '../../src/services/same-owner-settlement';
import type { OwnerClaim, OwnerResolution, AgentRef } from '../../src/services/agent-owner-resolver';
import { settleImmuneReceipt } from '../../src/immune/experimental-settlement';
import { experimentalScoresRouter } from '../../src/routes/experimental-repid';
import type { SignedCombinedReceipt, CombinedReceiptVerification } from '../../src/immune/combined-receipt';
import express from 'express';
import request from 'supertest';

beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

// ── in-memory supabase fake (same shape + unique-index/score-chain emulation as the sibling suite) ──
type Row = any;
interface Op { table: string; op: 'select' | 'insert' }
function fakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { repid_experimental_events: [], ...seed };
  const ops: Op[] = [];
  const rows = (t: string) => (tables[t] ??= []);
  const client = {
    from(table: string) {
      return {
        select(_cols?: string) {
          ops.push({ table, op: 'select' });
          const filters: [string, unknown][] = [];
          const run = () => ({ data: rows(table).filter((r) => filters.every(([c, v]) => r[c] === v)), error: null });
          const q: any = {
            eq(c: string, v: unknown) { filters.push([c, v]); return q; },
            async maybeSingle() { const { data } = run(); return { data: data[0] ?? null, error: null }; },
            then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return Promise.resolve(run()).then(ok, bad); },
          };
          return q;
        },
        insert(row: Row) {
          ops.push({ table, op: 'insert' });
          return {
            select() {
              return {
                async single() {
                  const t = rows(table);
                  if (table === 'repid_experimental_events') {
                    // the migration's two UNIQUE (domain, dimension, evidence_{id,hash}, mode) indexes
                    const clash = t.some((r) => r.domain === row.domain && r.dimension === row.dimension && r.mode === row.mode &&
                      (r.evidence_id === row.evidence_id || r.evidence_hash === row.evidence_hash));
                    if (clash) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
                    // the migration's BEFORE INSERT score chain: score_after = previous + delta, per (domain,agent,dimension,mode)
                    const prev = t.filter((r) => r.domain === row.domain && r.agent_id === row.agent_id && r.dimension === row.dimension && r.mode === row.mode);
                    const stored = { ...row, score_after: (prev.length ? prev[prev.length - 1].score_after : 0) + row.delta };
                    t.push(stored);
                    return { data: { score_after: stored.score_after }, error: null };
                  }
                  t.push(row); return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as any, ops, tables };
}

const APM = { id: '065ad782-ea58-4078-9414-60a862d67ba1', agent_id: 'trinity-apm', agent_name: 'trinity-apm' };
const MEL = { id: '942860a6-e26f-4334-ae94-b7c1abed1e8c', agent_id: 'trinity-mel', agent_name: 'trinity-mel' };
const answer = (decision: string, confidence?: number) =>
  JSON.stringify(confidence === undefined ? { decision } : { decision, confidence });
const row = (over: Partial<KnownAnswerRow> = {}): KnownAnswerRow =>
  ({ task_id: '435784', claimed_by: 'trinity-apm', case_id: 'case-1', result: answer('pass', 0.9), expected: 'pass', subject_agent_id: APM.id, ...over });
const setup = () => fakeDb({ repid_agents: [APM, MEL] });
const V = 'ka-v2-precommitted';

// ── P1. EVIDENCE ELIGIBILITY: only a VERIFIED + AUTHORITATIVE receipt is eligible ───────────────
describe('P1 evidence eligibility: unverified / un-authoritative receipts move nothing', () => {
  const stub = {} as unknown as SignedCombinedReceipt; // gates 1 return before the receipt body is read
  const ver = (over: Partial<CombinedReceiptVerification>): CombinedReceiptVerification =>
    ({ ok: true, authoritative: true, reasons: [], ...over } as CombinedReceiptVerification);

  test('a read-not-verified receipt (verification.ok=false) is unverified — not eligible', async () => {
    const out = await settleImmuneReceipt({ receipt: stub, verification: ver({ ok: false, reasons: ['signature_invalid'] }), agentId: APM.id }, { mode: 'shadow', enabled: true });
    expect(out.status).toBe('unverified');
  });

  test('an unauthenticated-envelope claim is refused: authoritative must be strictly true, not merely truthy', async () => {
    for (const loose of ['true', 1, {}, undefined]) {
      const out = await settleImmuneReceipt({ receipt: stub, verification: ver({ authoritative: loose as any }), agentId: APM.id }, { mode: 'shadow', enabled: true });
      expect(out.status).toBe('not_authoritative');
    }
  });

  test('POSITIVE CONTROL: verified + authoritative:true passes gate 1 (then mode off ⇒ off, still no write)', async () => {
    const out = await settleImmuneReceipt({ receipt: stub, verification: ver({}), agentId: APM.id }, { mode: 'off', enabled: true });
    expect(out.status).toBe('off'); // reached the mode gate, i.e. gate 1 did NOT refuse
  });
});

// ── P2. OWNER INDEPENDENCE (D-148): a same-controller pair is not independent corroboration ─────
describe('P2 owner independence: the experimental eligibility path inherits D-148', () => {
  const claim = (assurance: OwnerClaim['assurance'], key: string): OwnerClaim =>
    ({ source: 'repid_agents.builder_id', assurance, ownerKey: key, ownerKeyKind: 'builder_id', capUsdcPerTx: null, capUsdcTotal: null });
  const resolved = (c: OwnerClaim): OwnerResolution =>
    ({ status: 'resolved', agentId: 'x', owner: c, claims: [c], conflicts: [], reason: null, probes: [] });
  // eligibilityFor, driven through the REAL partyIndependence -> verifierIndependence (the D-148 rule).
  const eligibility = (a: OwnerResolution, b: OwnerResolution) =>
    eligibilityFor(APM.id, MEL.id, (x, y) => partyIndependence(x, y, async (ref: AgentRef) => (ref.id === APM.id ? a : b)));

  test('two DIFFERENT administrative builder_ids are NOT independent (admin proves sameness, never difference)', async () => {
    expect(await eligibility(resolved(claim('administrative', 'builder-A')), resolved(claim('administrative', 'builder-B'))))
      .toBe('same_controller_measured');
  });

  test('an "administrative-only" builder paired with a proven owner is still NOT independent (both sides need proof)', async () => {
    expect(await eligibility(resolved(claim('administrative', 'builder-A')), resolved(claim('proven_wallet', 'owner-B'))))
      .toBe('same_controller_measured');
  });

  test('an unverified attested claim (rank below the bar) is NOT independent', async () => {
    expect(await eligibility(resolved(claim('attested_unverified', 'key-A')), resolved(claim('attested_unverified', 'key-B'))))
      .toBe('same_controller_measured');
  });

  test('POSITIVE CONTROL: two DISTINCT proven_wallet owners in a shared namespace ARE independent', async () => {
    expect(await eligibility(resolved(claim('proven_wallet', 'owner-A')), resolved(claim('proven_wallet', 'owner-B'))))
      .toBe('independent_counterparty');
  });

  test('CONTROL: the SAME proven owner on both sides is same-controller (a shared key is a real shared link)', async () => {
    expect(await eligibility(resolved(claim('proven_wallet', 'owner-same')), resolved(claim('proven_wallet', 'owner-same'))))
      .toBe('same_controller_measured');
  });
});

// ── P3. NEGATIVE EVIDENCE: an adverse outcome lowers, persists, and survives a clone/transfer ───
describe('P3 negative evidence lowers score and cannot be erased or dodged by a clone', () => {
  const WRONG = row({ task_id: '5001', result: answer('veto', 0.8), expected: 'pass' }); // -(1+0.8) = -1.8

  test('an adverse outcome writes a negative delta and the chain carries it', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const r = await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(WRONG), version: V }, { store, mode: 'shadow' });
    expect(r).toMatchObject({ status: 'settled', delta: -1.8, score_after: -1.8 });
    expect(tables.repid_experimental_events).toHaveLength(1);
  });

  test('replaying the negative cannot flip it positive or overwrite it (already_consumed, row unchanged)', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(WRONG), version: V }, { store, mode: 'shadow' });
    // the one-time key already holds this evidence; re-submitting it is refused, so the stored negative stands.
    const replay = await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(WRONG), version: V }, { store, mode: 'shadow' });
    expect(replay).toEqual({ status: 'refused', reason: 'already_consumed' });
    expect(tables.repid_experimental_events).toHaveLength(1);
    expect(tables.repid_experimental_events[0].delta).toBe(-1.8); // unchanged, still negative
  });

  test('a CLONE (new uuid) cannot inherit the original agent\'s evidence to dodge the negative', async () => {
    const CLONE = { id: '11111111-1111-1111-1111-111111111111', agent_id: 'trinity-apm-2', agent_name: 'trinity-apm-2' };
    const { client } = fakeDb({ repid_agents: [APM, MEL, CLONE] });
    const store = supabaseExperimentalStore(client);
    // the clone re-points the subject to its own uuid and re-seals; the source row still names trinity-apm
    const stolen = sealEvidence({ ...knownAnswerEvidence(WRONG), subjectAgentId: CLONE.id });
    expect(await settleExperimental({ agentId: CLONE.id, evidence: stolen, version: V }, { store, mode: 'shadow' }))
      .toEqual({ status: 'refused', reason: 'subject_mismatch' }); // clone.agent_id 'trinity-apm-2' != content.claimed_by 'trinity-apm'
  });
});

// ── P4. REPLAY PROTECTION: a verbatim replay and a signature transplant are DIFFERENT attacks ───
describe('P4 replay protection: verbatim replay vs signature transplant, named distinctly', () => {
  test('ATTACK A — verbatim replay: the identical receipt a second time in the same ledger ⇒ already_consumed', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const ev = knownAnswerEvidence(row({ task_id: '6001' }));
    const first = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'active' });
    const again = await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'active' });
    expect(first.status).toBe('settled');
    expect(again).toEqual({ status: 'refused', reason: 'already_consumed' });
    expect(tables.repid_experimental_events).toHaveLength(1);
  });

  test('ATTACK B — signature transplant: grafting agent X\'s valid evidence onto agent Y ⇒ subject_mismatch (a distinct refusal)', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const aboutApm = knownAnswerEvidence(row({ task_id: '6002' }));
    const transplanted = sealEvidence({ ...aboutApm, subjectAgentId: MEL.id }); // re-seal so the hash is self-consistent
    expect(await settleExperimental({ agentId: MEL.id, evidence: transplanted, version: V }, { store, mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'subject_mismatch' });
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('cross-ledger semantics: the SAME evidence settles once PER MODE (shadow + active are separate ledgers BY DESIGN), and shadow never gates', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    const ev = knownAnswerEvidence(row({ task_id: '6003' }));
    // the one-time key is (domain, dimension, evidence_id, MODE): so shadow and active each hold one row.
    expect((await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'shadow' })).status).toBe('settled');
    expect((await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'active' })).status).toBe('settled');
    // but a second ACTIVE settle of the same evidence is still refused — the gating ledger admits it once.
    expect(await settleExperimental({ agentId: APM.id, evidence: ev, version: V }, { store, mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'already_consumed' });
    expect(tables.repid_experimental_events.map((r: Row) => r.mode).sort()).toEqual(['active', 'shadow']);
    // this is safe because only ACTIVE rows can gate: a shadow row never changes a tier.
    expect(experimentalTier([{ dimension: 'validator', mode: 'shadow', n: 10_000, score: 9_999 }])).toBe('exp-unproven');
  });
});

// ── P5. CONTROLLER LINEAGE: evidence from the wrong agent cannot resurrect or transfer reputation ─
describe('P5 controller lineage: reputation is bound to the agent AND to the source row\'s own worker', () => {
  test('evidence whose source row was claimed by a DIFFERENT agent cannot credit this one (even re-sealed)', async () => {
    const { client, tables } = setup();
    const store = supabaseExperimentalStore(client);
    // "credit MEL's actual work to APM's row": subject uuid = APM, but the source row's claimed_by = trinity-mel.
    const melsWork = sealEvidence({ ...knownAnswerEvidence(row({ task_id: '7001', claimed_by: 'trinity-mel', subject_agent_id: MEL.id })), subjectAgentId: APM.id });
    expect(await settleExperimental({ agentId: APM.id, evidence: melsWork, version: V }, { store, mode: 'active' }))
      .toEqual({ status: 'refused', reason: 'subject_mismatch' }); // APM.agent_id 'trinity-apm' != content.claimed_by 'trinity-mel'
    expect(tables.repid_experimental_events).toHaveLength(0);
  });

  test('POSITIVE CONTROL: evidence whose claimed_by matches the subject agent settles', async () => {
    const { client } = setup();
    const store = supabaseExperimentalStore(client);
    expect((await settleExperimental({ agentId: APM.id, evidence: knownAnswerEvidence(row({ task_id: '7002' })), version: V }, { store, mode: 'active' })).status)
      .toBe('settled');
  });
});

// ── P6. TWO-NUMBER MODEL: the eligibility split is two counts, never summed; label + flag fixed ──
describe('P6 two-number model: same_controller and independent_counterparty are reported separately', () => {
  const app = (client: any) => express().use('/api/v1/experimental', experimentalScoresRouter(client));

  test('a NEGATIVE same-controller score and an independent count coexist without being merged or hidden', async () => {
    const { client } = fakeDb({
      repid_experimental_scores: [
        // validator: net-negative, all same-controller — reported as-is, not clamped, not laundered into "independent".
        { domain: EXPERIMENTAL_DOMAIN, agent_id: APM.id, dimension: 'validator', mode: 'active', n: 40, score: '-12.5',
          n_same_controller_measured: 40, n_independent_counterparty: 0, scoring_versions: [V], last_event_at: '2026-11-07T00:00:00Z' },
      ],
    });
    const res = await request(app(client)).get(`/api/v1/experimental/agents/${APM.id}/scores`);
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(EXPERIMENTAL_LABEL);
    expect(res.body.independent_reputation).toBe(false); // fixed on every response, whatever the numbers
    expect(res.body.scores[0]).toMatchObject({
      dimension: 'validator', mode: 'active', n: 40, score: -12.5, // negative preserved
      eligibility: { same_controller_measured: 40, independent_counterparty: 0 }, // two numbers, kept apart
    });
  });
});
