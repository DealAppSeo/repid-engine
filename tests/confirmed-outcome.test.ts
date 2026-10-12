/**
 * confirmed-outcome.test.ts — the confirmed-outcome scoring policy, rule by rule.
 *
 * Each of the six rules the lane was built for has its own block. The magnitudes are
 * PINNED here via env before each test (then the param cache is reset), so every exact
 * number asserted below is a TEST value this file set — never a dev placeholder taken on
 * faith and never production tuning. This is the discipline
 * `scoring-tuning-not-in-repo.test.ts` requires of any exact assertion on a tuned scorer.
 *
 * CWE-345: the policy settles ONLY on a SERVER-DERIVED `verifiedConfirmation`. The rule
 * blocks below supply one (via `base()` / `vc()`) because they describe "what happens once
 * a verifier has confirmed the outcome". The SERVER-VERIFICATION GATE block proves the
 * other half: a caller-asserted confirmation with NO `verifiedConfirmation` settles NOTHING.
 *
 * Three assertions are marked NON-VACUITY GUARD: they go RED if the code is mutated to let
 * a 2-1 vote settle, to let a same-family counterparty confirm, or to trust a caller-asserted
 * confirmation with no server verification.
 */
import {
  resolveConfirmedOutcome,
  __resetConfirmedParamsCache,
  loadConfirmedParams,
  type ConfirmedOutcomeDeps,
  type ConfirmedOutcomeInput,
  type ConfirmedSettler,
  type ConfirmedVerifiedSource,
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
});
afterEach(() => {
  for (const k of Object.keys(PINNED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  __resetConfirmedParamsCache();
});

const ACTOR = 'actor-1';
const SOURCE: Record<ConfirmedSettler, ConfirmedVerifiedSource> = {
  holdout: 'kernel_receipt',
  known_answer: 'known_answer_record',
  person: 'signed_attestation',
  counterparty: 'independent_counterparty',
};
/** A SERVER-DERIVED confirmation, as a verifier would produce (tests stand in for the verifier). */
const vc = (s: ConfirmedSettler): VerifiedConfirmation => ({ source: SOURCE[s], settledBy: s });

/**
 * base() attaches a server-verified confirmation matching `settledBy` — the "a verifier has
 * already confirmed this" world the rule blocks describe. Gate tests override with
 * `verifiedConfirmation: undefined` to simulate a raw caller-asserted payload.
 */
const base = (over: Partial<ConfirmedOutcomeInput>): ConfirmedOutcomeInput => {
  const settledBy = over.settledBy ?? 'holdout';
  const realSettler = settledBy === 'holdout' || settledBy === 'known_answer' || settledBy === 'person' || settledBy === 'counterparty';
  return {
    actorAgentId: ACTOR,
    settledBy,
    result: 'right',
    ...(realSettler ? { verifiedConfirmation: vc(settledBy as ConfirmedSettler) } : {}),
    ...over,
  };
};

const independentDeps = (): ConfirmedOutcomeDeps => ({
  resolveOwner: async (id) => ({ status: 'resolved', ownerKey: id === ACTOR ? 'owner-A' : 'owner-B' }),
  readModelFamily: async (id) => (id === ACTOR ? 'llama' : 'gemini'),
});

describe('loader invariants (rules 2 & 5 encoded as machine-checked structure)', () => {
  it('rejects a rubber-stamp lighter than ten maximally need-boosted rights', () => {
    const env = { ...PINNED, REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-60' } as NodeJS.ProcessEnv;
    expect(() => loadConfirmedParams(env)).toThrow(/ten confirmed rights/);
  });
  it('rejects a band-tighten that is not smaller than a full loss', () => {
    const env = { ...PINNED, REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-15' } as NodeJS.ProcessEnv;
    expect(() => loadConfirmedParams(env)).toThrow(/tightens the band/);
  });
  it('rejects a self-report factor that is not strictly between 0 and 1', () => {
    const env = { ...PINNED, REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '1' } as NodeJS.ProcessEnv;
    expect(() => loadConfirmedParams(env)).toThrow(/costs less than one found later/);
  });
  it('rejects a loss base that does not exceed the gain base', () => {
    const env = { ...PINNED, REPID_CONFIRMED_LOSS_BASE: '-5' } as NodeJS.ProcessEnv;
    expect(() => loadConfirmedParams(env)).toThrow(/must cost more than a confirmed right/);
  });
});

describe('CWE-345 SERVER-VERIFICATION GATE — a caller-asserted confirmation settles nothing', () => {
  it.each(['holdout', 'known_answer', 'person'] as const)(
    'a caller-asserted %s (no verifiedConfirmation) does NOT move the score',
    async (settler) => {
      const r = await resolveConfirmedOutcome(base({ settledBy: settler, result: 'right', verifiedConfirmation: undefined }));
      expect(r.confirmed).toBe(false);
      expect(r.scoreMoves).toBe(false);
      expect(r.appliedDelta).toBe(0);
      expect(r.detail.serverVerified).toBe(false);
      expect(r.reason).toBe('confirmation_not_server_verified');
    },
  );

  it('NON-VACUITY GUARD: a caller-asserted confirmed-RIGHT does not earn a gain', async () => {
    // If the gate were removed (trusting the caller settledBy), this would be +5 and go red.
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'right', verifiedConfirmation: undefined }));
    expect(r.scoreMoves).toBe(false);
    expect(r.appliedDelta).toBe(0);
  });

  it('a caller-asserted rubber-stamp cannot inflict the heavy penalty', async () => {
    const r = await resolveConfirmedOutcome(base({ result: 'wrong', rubberStampKnownWrong: true, verifiedConfirmation: undefined }));
    expect(r.scoreMoves).toBe(false);
    expect(r.appliedDelta).toBe(0);
  });

  it('a caller-asserted unsupported-PASS cannot inflict the confident-wrong penalty', async () => {
    const r = await resolveConfirmedOutcome(base({ result: 'right', passUnsupportedByReceipt: true, verifiedConfirmation: undefined }));
    expect(r.scoreMoves).toBe(false);
    expect(r.appliedDelta).toBe(0);
  });

  it('a caller-asserted counterparty (even with independent deps) does not move the score', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1', verifiedConfirmation: undefined }),
      independentDeps(),
    );
    expect(r.scoreMoves).toBe(false);
    expect(r.reason).toBe('confirmation_not_server_verified');
  });

  it('a server source that disagrees with the caller settledBy fails closed (settler_mismatch)', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'right', verifiedConfirmation: vc('person') }),
    );
    expect(r.confirmed).toBe(false);
    expect(r.reason).toBe('settler_mismatch');
  });
});

describe('RULE 1 — the official score moves ONLY on a confirmed outcome', () => {
  it.each(['holdout', 'known_answer', 'person'] as const)(
    'a server-verified %s settler confirms → SETTLED, score moves',
    async (settler) => {
      const r = await resolveConfirmedOutcome(base({ settledBy: settler, result: 'right' }));
      expect(r.confirmed).toBe(true);
      expect(r.verdictLabel).toBe('SETTLED');
      expect(r.settledBy).toBe(settler);
      expect(r.scoreMoves).toBe(true);
      expect(r.appliedDelta).toBe(5);
      expect(r.detail.serverVerified).toBe(true);
    },
  );

  it('NON-VACUITY GUARD: a 2-1 vote is PROVISIONAL and does NOT move the score', async () => {
    // Even if a verifiedConfirmation were present, a vote is never a server settler.
    const r = await resolveConfirmedOutcome(base({ settledBy: 'vote', result: 'right' }));
    expect(r.confirmed).toBe(false);
    expect(r.verdictLabel).toBe('PROVISIONAL');
    expect(r.scoreMoves).toBe(false);
    expect(r.appliedDelta).toBe(0);
    expect(r.reason).toMatch(/vote_is_provisional/);
  });

  it('a null settler does not confirm', async () => {
    const r = await resolveConfirmedOutcome(base({ settledBy: null, result: 'right', verifiedConfirmation: undefined }));
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
  });
});

describe('RULE 2 — asymmetric gain/loss, confidence-weighted, rubber-stamp heaviest', () => {
  it('a confirmed right earns a SMALL gain', async () => {
    const r = await resolveConfirmedOutcome(base({ result: 'right' }));
    expect(r.appliedDelta).toBe(5);
  });

  it('a confirmed wrong costs MORE than a confirmed right (even at zero confidence)', async () => {
    const wrong = await resolveConfirmedOutcome(base({ result: 'wrong', confidence: 0 }));
    expect(wrong.appliedDelta).toBe(-15);
    expect(Math.abs(wrong.appliedDelta)).toBeGreaterThan(5);
  });

  it('a confident wrong costs MORE still (loss scales with confidence, monotonic)', async () => {
    const hedged = await resolveConfirmedOutcome(base({ result: 'wrong', confidence: 0 }));
    const mid = await resolveConfirmedOutcome(base({ result: 'wrong', confidence: 0.5 }));
    const confident = await resolveConfirmedOutcome(base({ result: 'wrong', confidence: 1 }));
    expect(confident.appliedDelta).toBe(-55);
    expect(mid.appliedDelta).toBe(-35);
    expect(confident.appliedDelta).toBeLessThan(mid.appliedDelta);
    expect(mid.appliedDelta).toBeLessThan(hedged.appliedDelta);
  });

  it('a rubber-stamp of a known-wrong costs MORE than the last ten confirmed rights combined', async () => {
    const right = await resolveConfirmedOutcome(base({ result: 'right' }));
    const rubber = await resolveConfirmedOutcome(
      base({ result: 'wrong', rubberStampKnownWrong: true, verifiedConfirmation: vc('known_answer') }),
    );
    expect(rubber.appliedDelta).toBe(-120);
    expect(rubber.settledBy).toBe('known_answer');
    expect(Math.abs(rubber.appliedDelta)).toBeGreaterThan(Math.abs(right.appliedDelta) * 10);
    const confidentWrong = await resolveConfirmedOutcome(base({ result: 'wrong', confidence: 1 }));
    expect(Math.abs(rubber.appliedDelta)).toBeGreaterThan(Math.abs(confidentWrong.appliedDelta));
  });
});

describe('RULE 3 — abstain is free; an unsupported PASS pays the confident-wrong penalty', () => {
  it('abstain → zero delta, no move (free)', async () => {
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'abstain' }));
    expect(r.appliedDelta).toBe(0);
    expect(r.scoreMoves).toBe(false);
    expect(r.reason).toBe('abstain_free');
  });

  it('a server-verified unsupported PASS is a confident wrong (full penalty), confirmed by the receipt', async () => {
    const r = await resolveConfirmedOutcome(
      base({ result: 'right', passUnsupportedByReceipt: true, verifiedConfirmation: vc('holdout') }),
    );
    expect(r.appliedDelta).toBe(-55);
    expect(r.confirmed).toBe(true);
    expect(r.settledBy).toBe('holdout');
    expect(r.scoreMoves).toBe(true);
    expect(r.reason).toBe('pass_unsupported_by_receipt');
  });
});

describe('RULE 4 — counterparty independence / no self-deal (fail closed)', () => {
  it('a server-verified independent counterparty (distinct owner AND family) confirms', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      independentDeps(),
    );
    expect(r.confirmed).toBe(true);
    expect(r.settledBy).toBe('counterparty');
    expect(r.detail.independence?.independent).toBe(true);
  });

  it('the actor cannot confirm itself (self-deal)', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: ACTOR }),
      independentDeps(),
    );
    expect(r.confirmed).toBe(false);
    expect(r.detail.independence?.reason).toBe('self_deal_same_agent');
  });

  it('a sibling under the SAME OWNER does not confirm', async () => {
    const sameOwner: ConfirmedOutcomeDeps = {
      resolveOwner: async () => ({ status: 'resolved', ownerKey: 'owner-SHARED' }),
      readModelFamily: async (id) => (id === ACTOR ? 'llama' : 'gemini'),
    };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      sameOwner,
    );
    expect(r.confirmed).toBe(false);
    expect(r.detail.independence?.reason).toBe('same_owner_sibling');
  });

  it('NON-VACUITY GUARD: a SAME-FAMILY counterparty does NOT confirm', async () => {
    const sameFamily: ConfirmedOutcomeDeps = {
      resolveOwner: async (id) => ({ status: 'resolved', ownerKey: id === ACTOR ? 'owner-A' : 'owner-B' }),
      readModelFamily: async () => 'llama',
    };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      sameFamily,
    );
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
    expect(r.detail.independence?.reason).toBe('same_model_family');
  });

  it('FAIL CLOSED: owner unresolvable → not confirmed, no move', async () => {
    const unknownOwner: ConfirmedOutcomeDeps = {
      resolveOwner: async () => ({ status: 'unknown', ownerKey: null }),
      readModelFamily: async (id) => (id === ACTOR ? 'llama' : 'gemini'),
    };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      unknownOwner,
    );
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
    expect(r.detail.independence?.reason).toMatch(/owner_not_established/);
  });

  it('FAIL CLOSED: model family unreadable (field absent) → not confirmed', async () => {
    const noFamily: ConfirmedOutcomeDeps = {
      resolveOwner: async (id) => ({ status: 'resolved', ownerKey: id === ACTOR ? 'owner-A' : 'owner-B' }),
      readModelFamily: async () => null,
    };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      noFamily,
    );
    expect(r.confirmed).toBe(false);
    expect(r.detail.independence?.reason).toBe('model_family_not_checked');
  });

  it('FAIL CLOSED: a thrown dependency does not throw into the score path', async () => {
    const boom: ConfirmedOutcomeDeps = {
      resolveOwner: async () => { throw new Error('store down'); },
      readModelFamily: async () => 'x',
    };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: 'cp-1' }),
      boom,
    );
    expect(r.confirmed).toBe(false);
    expect(r.scoreMoves).toBe(false);
  });

  it('FAIL CLOSED: missing counterparty id → not confirmed', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'counterparty', result: 'right', counterpartyAgentId: null }),
      independentDeps(),
    );
    expect(r.confirmed).toBe(false);
    expect(r.detail.independence?.reason).toBe('counterparty_id_missing');
  });
});

describe('RULE 5 — first miss in a NEW domain tightens the band, does not wipe', () => {
  const newDomainDeps: ConfirmedOutcomeDeps = { domainTrackRecord: async () => ({ checked: true, hasRecord: false }) };
  const establishedDeps: ConfirmedOutcomeDeps = { domainTrackRecord: async () => ({ checked: true, hasRecord: true }) };

  it('a first confirmed miss in a NEW domain band-tightens (bounded), not a full wipe', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law' }),
      newDomainDeps,
    );
    expect(r.bandTightened).toBe(true);
    expect(r.appliedDelta).toBe(-8);
    expect(Math.abs(r.appliedDelta)).toBeLessThan(55);
  });

  it('a confirmed miss in an ESTABLISHED domain takes the full confident loss', async () => {
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law' }),
      establishedDeps,
    );
    expect(r.bandTightened).toBe(false);
    expect(r.appliedDelta).toBe(-55);
  });

  it('a self-reported miss costs LESS than one found later', async () => {
    const found = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law' }),
      establishedDeps,
    );
    const selfReported = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law', selfReportedMiss: true }),
      establishedDeps,
    );
    expect(Math.abs(selfReported.appliedDelta)).toBeLessThan(Math.abs(found.appliedDelta));
  });

  it('restoration: a confirmed RIGHT in the tightened domain is a positive delta', async () => {
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'right', domain: 'law' }), newDomainDeps);
    expect(r.appliedDelta).toBeGreaterThan(0);
  });

  it('history unreadable → treated as new domain (do not over-penalize on uncertainty)', async () => {
    const unreadable: ConfirmedOutcomeDeps = { domainTrackRecord: async () => ({ checked: false, hasRecord: false }) };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 1, domain: 'law' }),
      unreadable,
    );
    expect(r.bandTightened).toBe(true);
    expect(r.appliedDelta).toBe(-8);
  });
});

describe('RULE 6 — per-domain need multiplier raises gains, capped, never a loss', () => {
  it('unmet demand RAISES the gain for a confirmed right', async () => {
    const deps: ConfirmedOutcomeDeps = { domainNeedWeight: async () => 2 };
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'right', domain: 'law' }), deps);
    expect(r.appliedDelta).toBe(10);
    expect(r.needMultiplierApplied).toBe(2);
  });

  it('as supply arrives the multiplier FALLS toward 1 (never shrinks a gain below base)', async () => {
    const deps: ConfirmedOutcomeDeps = { domainNeedWeight: async () => 0.5 };
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'right', domain: 'law' }), deps);
    expect(r.appliedDelta).toBe(5);
    expect(r.needMultiplierApplied).toBe(1);
  });

  it('need CANNOT raise the ceiling: the multiplier is capped', async () => {
    const deps: ConfirmedOutcomeDeps = { domainNeedWeight: async () => 1000 };
    const r = await resolveConfirmedOutcome(base({ settledBy: 'holdout', result: 'right', domain: 'law' }), deps);
    expect(r.appliedDelta).toBe(10);
    expect(r.needMultiplierApplied).toBe(2);
  });

  it('need is NOT applied to a loss', async () => {
    const deps: ConfirmedOutcomeDeps = { domainNeedWeight: async () => 2, domainTrackRecord: async () => ({ checked: true, hasRecord: true }) };
    const r = await resolveConfirmedOutcome(
      base({ settledBy: 'holdout', result: 'wrong', confidence: 0, domain: 'law' }),
      deps,
    );
    expect(r.appliedDelta).toBe(-15);
  });
});
