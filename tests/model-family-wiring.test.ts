/**
 * model-family-wiring.test.ts — #1338 follow-up: the first-class `repid_agents.model_family`
 * COLUMN is the PRIMARY source for the counterparty independence check (confirmed-outcome
 * rule 4), with the `capabilities.model_family` jsonb kept as FALLBACK, failing closed when
 * both are absent.
 *
 * Two layers, both non-vacuous (LESSONS rule 5 — an instrument that cannot return the OTHER
 * answer has measured nothing; every property here is shown going BOTH ways):
 *
 *   (A) modelFamilyOf(column, capabilities) — the pure resolver. Proves column-first
 *       precedence, jsonb fallback, and null (fail-closed) when both are absent.
 *   (B) confirmedOutcomeDepsFor(...).readModelFamily wired end-to-end through the REAL
 *       resolveConfirmedOutcome with a server-verified counterparty confirmation. Proves the
 *       column actually DRIVES independence: different column families confirm, the same
 *       family refuses, both-absent refuses (fail closed), the jsonb fallback confirms, and
 *       the column WINS over a conflicting jsonb.
 *
 * NON-VACUITY GUARDS are marked. The both-absent case goes RED if modelFamilyOf is mutated to
 * invent a family on absence OR if the rule-4 check is mutated to treat an absent family as
 * independent; the column-precedence case goes RED if the jsonb is read before the column.
 *
 * This lane sets NO flag: CONFIRMED_OUTCOME_SCORING_ENABLED stays default OFF. The resolver is
 * driven directly (as confirmed-outcome.test.ts does) to exercise the real wired deps; it does
 * NOT go through updateRepId, whose CWE-345 gate correctly strips any caller verifiedConfirmation.
 */

// Per-agent rows the mocked DB returns for NON-actor reads (the actor row is passed in-memory).
const agentRows: Record<string, { model_family?: unknown; capabilities?: unknown } | null> = {};

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table !== 'repid_agents') throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string) => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => ({ data: agentRows[id] ?? null, error: null }),
          }),
        }),
      };
    },
  },
}));

jest.mock('../src/services/agent-owner-resolver', () => ({
  // Distinct owner per agent id → owner-independence passes, so every scenario reaches the
  // model-family leg (which is what this file is about).
  resolveOwner: jest.fn(async (ref: { id: string }) => ({
    status: 'resolved',
    owner: { ownerKey: `owner-${ref.id}` },
  })),
}));

import {
  confirmedOutcomeDepsFor,
  modelFamilyOf,
} from '../src/engine/repid-update';
import {
  resolveConfirmedOutcome,
  __resetConfirmedParamsCache,
  type ConfirmedOutcomeInput,
  type VerifiedConfirmation,
} from '../src/scoring/confirmed-outcome';

const PINNED: Record<string, string> = {
  REPID_CONFIRMED_GAIN_BASE: '5',
  REPID_CONFIRMED_LOSS_BASE: '-15',
  REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT: '40',
  REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-120',
  REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-8',
  REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '0.5',
  REPID_CONFIRMED_NEED_WEIGHT_CAP: '2',
};
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(PINNED)) { SAVED[k] = process.env[k]; process.env[k] = PINNED[k]; }
  __resetConfirmedParamsCache();
  for (const k of Object.keys(agentRows)) delete agentRows[k];
});
afterEach(() => {
  for (const k of Object.keys(PINNED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  __resetConfirmedParamsCache();
});

// ── (A) the pure resolver ──────────────────────────────────────────────────────────────────

describe('(A) modelFamilyOf — column-first, jsonb fallback, null when both absent', () => {
  it('PREFERS the column when present (even if the jsonb disagrees)', () => {
    expect(modelFamilyOf('gemini', { model_family: 'llama' })).toBe('gemini');
    expect(modelFamilyOf('  kimi  ', null)).toBe('kimi'); // trimmed
  });

  it('FALLS BACK to the jsonb when the column is absent/blank', () => {
    expect(modelFamilyOf(null, { model_family: 'llama' })).toBe('llama');
    expect(modelFamilyOf(undefined, { modelFamily: 'deepseek' })).toBe('deepseek'); // camelCase too
    expect(modelFamilyOf('', { model_family: 'glm' })).toBe('glm');
    expect(modelFamilyOf('   ', { model_family: 'qwen' })).toBe('qwen');
  });

  it('FAILS CLOSED (null) when BOTH are absent/unreadable', () => {
    // NON-VACUITY: a mutation inventing a family on absence makes these return a string → RED.
    expect(modelFamilyOf(null, null)).toBeNull();
    expect(modelFamilyOf(undefined, undefined)).toBeNull();
    expect(modelFamilyOf('   ', {})).toBeNull();
    expect(modelFamilyOf('', { nothing_useful: true })).toBeNull();
    expect(modelFamilyOf(42, 'not-an-object')).toBeNull(); // non-string column, non-object caps
  });
});

// ── (B) the wiring, end-to-end through the real resolver ─────────────────────────────────────

// result:'right' matches cpInput().result — the server establishes the same result the caller asserts.
const COUNTERPARTY_VC: VerifiedConfirmation = { source: 'independent_counterparty', settledBy: 'counterparty', result: 'right' };

/** A confirmed-right counterparty outcome, server-verified, actor vs cp. */
function cpInput(): ConfirmedOutcomeInput {
  return {
    actorAgentId: 'actor',
    settledBy: 'counterparty',
    result: 'right',
    counterpartyAgentId: 'cp',
    verifiedConfirmation: COUNTERPARTY_VC,
  };
}

async function resolveWith(
  actorRow: { id: string; model_family?: unknown; capabilities?: unknown },
  cpRow: { model_family?: unknown; capabilities?: unknown } | null,
) {
  agentRows['cp'] = cpRow;
  const deps = confirmedOutcomeDepsFor(actorRow);
  return resolveConfirmedOutcome(cpInput(), deps);
}

describe('(B) confirmedOutcomeDepsFor.readModelFamily drives rule-4 independence from the COLUMN', () => {
  it('DIFFERENT column families → independent → CONFIRMED (presence: it CAN confirm)', async () => {
    const r = await resolveWith({ id: 'actor', model_family: 'gemini' }, { model_family: 'llama' });
    expect(r.confirmed).toBe(true);
    expect(r.settledBy).toBe('counterparty');
    expect(r.scoreMoves).toBe(true);
    expect(r.appliedDelta).toBe(5); // gainBase
    expect(r.detail.independence?.independent).toBe(true);
    expect(r.detail.independence?.reason).toBe('independent');
  });

  it('SAME column family → NOT independent (same_model_family), no move', async () => {
    const r = await resolveWith({ id: 'actor', model_family: 'llama' }, { model_family: 'llama' });
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
    expect(r.detail.independence?.reason).toBe('same_model_family');
  });

  it('NON-VACUITY: BOTH families absent (no column, no jsonb) → model_family_not_checked, FAILS CLOSED', async () => {
    // Column absent on both AND jsonb absent on both → null from readModelFamily → refused.
    // A mutation that invented a family, or treated absence as independent, would CONFIRM here → RED.
    const r = await resolveWith({ id: 'actor' }, {});
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
    expect(r.appliedDelta).toBe(0);
    expect(r.detail.independence?.reason).toBe('model_family_not_checked');
  });

  it('FALLBACK proven end-to-end: no column but DIFFERENT jsonb families → CONFIRMED', async () => {
    const r = await resolveWith(
      { id: 'actor', capabilities: { model_family: 'deepseek' } },
      { capabilities: { model_family: 'kimi' } },
    );
    expect(r.confirmed).toBe(true);
    expect(r.detail.independence?.independent).toBe(true);
  });

  it('COLUMN WINS over a conflicting jsonb (discriminator: jsonb-first would refuse)', async () => {
    // Both agents share the SAME jsonb family ('llama') but have DIFFERENT columns. Column-first:
    // actor 'gemini' != cp 'deepseek' → independent → CONFIRMED. If the jsonb were read first, BOTH
    // would read 'llama' == 'llama' → same_model_family → NOT confirmed. So a green here PROVES
    // column precedence in the wiring (and goes RED the instant the jsonb is consulted first).
    const r = await resolveWith(
      { id: 'actor', model_family: 'gemini', capabilities: { model_family: 'llama' } },
      { model_family: 'deepseek', capabilities: { model_family: 'llama' } },
    );
    expect(r.confirmed).toBe(true);
    expect(r.detail.independence?.independent).toBe(true);
  });

  it('stale schema (column read yields no row) → fail closed via jsonb absence', async () => {
    // Simulates the pre-apply world for a NON-actor read: the DB returns no row (as a missing
    // column select would), so readModelFamily returns null and the counterparty stays refused.
    const r = await resolveWith({ id: 'actor', model_family: 'gemini' }, null);
    expect(r.confirmed).toBe(false);
    expect(r.detail.independence?.reason).toBe('model_family_not_checked');
  });
});
