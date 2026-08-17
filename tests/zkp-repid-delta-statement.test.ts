/**
 * ZKP RepID — the delta statement.
 *
 * The properties pinned here are the ones that make a circuit possible later. Above
 * all: the canonical digest is a KAT. A circuit that absorbs the same values in a
 * different order verifies nothing and fails silently, so the byte-exact digest of a
 * fixed statement is frozen in this file and any reordering breaks the build.
 */

import {
  CURRENT_FORMULA_PARAMS,
  DELTA_BAND_MAX,
  DELTA_BAND_MIN,
  DELTA_SCALE,
  FORMULA_SALT_ENV,
  REPID_DELTA_DOMAIN,
  REPID_DELTA_STATEMENT_SCHEME,
  agentCommitment,
  buildRepidDeltaStatement,
  checkConsistency,
  deltaStatementMode,
  deriveNullifier,
  feltFromDelta,
  feltFromRatio,
  feltFromSigned,
  feltsFromString,
  formulaCommitment,
  nullifierScope,
  statementDigest,
  verifyRepidDeltaStatement,
  type BuildStatementParams,
} from '../src/zkp/repid-delta-statement';
import { computeDelta } from '../src/scoring/repid-delta';
import { REPID_MAX, REPID_MIN } from '../src/scoring/repid-clamp';
import {
  IDENTITY_SECRET_WIDTH,
  identitySecretFromFelts,
  nullifierMatchesSecret,
} from '../src/zkp/nullifier-identity';

/**
 * A fixed 8-element identity secret (~248 bits). Was a single `bigint` derived from the
 * formula salt; see `src/zkp/nullifier-identity.ts` for why one element could not work
 * regardless of where it came from.
 */
const TEST_IDENTITY_SECRET = identitySecretFromFelts({
  felts: Array.from({ length: IDENTITY_SECRET_WIDTH }, (_, i) => 0x5eed_beefn + BigInt(i)),
  domain: REPID_DELTA_DOMAIN,
});

const SALT = 'test-salt-not-the-production-one';
const withSalt = <T>(fn: () => T): T => {
  const prev = process.env[FORMULA_SALT_ENV];
  process.env[FORMULA_SALT_ENV] = SALT;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FORMULA_SALT_ENV];
    else process.env[FORMULA_SALT_ENV] = prev;
  }
};

/**
 * A clean event: RISK 0.25 → quality 0.75 → raw = 1 + (0.75-0.5)*4 = 2.0.
 *
 * Was `hal_score: 0.75`. That produced the same +2 under the pre-2026-08-17 clean branch, but it
 * is unreachable — `deriveHalDecision` flags anything >= 0.40, so 'clean' at risk 0.75 cannot
 * occur. The branch now consumes QUALITY (delta = 3 - 4*risk), so risk 0.25 gives +2 and is a
 * combination production can actually produce.
 */
const cleanParams = (over: Partial<BuildStatementParams> = {}): BuildStatementParams => ({
  agentId: 'agent-shofet',
  scopeLabel: 'event-0001',
  witness: {
    hal_score: 0.25,
    hal_decision: 'clean',
    current_repid: 1611,
    agent_tier: 'ESTABLISHED',
    vesting_cliff_active: false,
    identitySecret: TEST_IDENTITY_SECRET,
  },
  deltaApplied: 2,
  scoreBefore: 1611,
  scoreAfter: 1613,
  ...over,
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe('field encoding', () => {
  it('THE BUG I SHIPPED FIRST: deltas are not integers', () => {
    // repid-delta.ts computes clean deltas as Math.round(raw*10)/10, so +2.6 is a real
    // and common value. feltFromSigned throws on it; feltFromDelta must not.
    expect(() => feltFromSigned(2.6)).toThrow();
    expect(() => feltFromDelta(2.6)).not.toThrow();
    expect(feltFromDelta(2.6)).toBe(feltFromSigned(26));
  });

  it('encodes the whole live delta band exactly, at the formula‘s own precision', () => {
    for (let scaled = DELTA_BAND_MIN * DELTA_SCALE; scaled <= DELTA_BAND_MAX * DELTA_SCALE; scaled++) {
      expect(() => feltFromDelta(scaled / DELTA_SCALE)).not.toThrow();
    }
  });

  it('refuses a delta with finer precision rather than rounding its own subject', () => {
    expect(() => feltFromDelta(2.64)).toThrow(/finer precision/);
  });

  it('is injective over signed values, including across zero', () => {
    const seen = new Set<string>();
    for (const n of [-10, -1, 0, 1, 10, 1611, 10000]) {
      const f = feltFromSigned(n).toString();
      expect(seen.has(f)).toBe(false);
      seen.add(f);
    }
  });

  it('absorbs string length first, so concatenations cannot collide', () => {
    // "ab"+"c" vs "a"+"bc" — the classic length-extension collision.
    const a = [...feltsFromString('ab'), ...feltsFromString('c')];
    const b = [...feltsFromString('a'), ...feltsFromString('bc')];
    expect(a).not.toEqual(b);
  });

  it('quantises a ratio at a fixed scale, so engine and circuit agree', () => {
    expect(feltFromRatio(0.75)).toBe(750000n);
    expect(feltFromRatio(0)).toBe(0n);
    expect(feltFromRatio(1)).toBe(1000000n);
    expect(() => feltFromRatio(1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The formula commitment
// ---------------------------------------------------------------------------

describe('formula commitment — the hard stop, respected', () => {
  it('FAILS CLOSED with no salt, rather than emitting a brute-forceable digest', () => {
    const prev = process.env[FORMULA_SALT_ENV];
    delete process.env[FORMULA_SALT_ENV];
    try {
      expect(() => formulaCommitment()).toThrow(/UNSALTED/);
    } finally {
      if (prev !== undefined) process.env[FORMULA_SALT_ENV] = prev;
    }
  });

  it('is deterministic for the same params and salt', () => {
    withSalt(() => expect(formulaCommitment()).toBe(formulaCommitment()));
  });

  it('THE LOAD-BEARING PROPERTY: a changed formula changes the commitment', () => {
    withSalt(() => {
      const base = formulaCommitment();
      // Quietly widen the band for one favoured agent — the commitment must diverge,
      // which is how an outsider detects it without ever seeing the formula.
      const tampered = formulaCommitment({ ...CURRENT_FORMULA_PARAMS, bandMax: 50 });
      expect(tampered).not.toBe(base);
      const bumped = formulaCommitment({ ...CURRENT_FORMULA_PARAMS, version: 'repid-delta-a8' });
      expect(bumped).not.toBe(base);
    });
  });

  it('a different salt gives a different commitment — so the salt must be stable', () => {
    const a = formulaCommitment(CURRENT_FORMULA_PARAMS, 'salt-one');
    const b = formulaCommitment(CURRENT_FORMULA_PARAMS, 'salt-two');
    expect(a).not.toBe(b);
  });

  it('commits to the bounds the rest of the code actually enforces', () => {
    expect(CURRENT_FORMULA_PARAMS.bandMin).toBe(DELTA_BAND_MIN);
    expect(CURRENT_FORMULA_PARAMS.bandMax).toBe(DELTA_BAND_MAX);
    expect(CURRENT_FORMULA_PARAMS.scoreFloor).toBe(REPID_MIN);
    expect(CURRENT_FORMULA_PARAMS.scoreCeiling).toBe(REPID_MAX);
  });
});

// ---------------------------------------------------------------------------
// The band matches the formula it claims to bound
// ---------------------------------------------------------------------------

describe('the published band actually bounds the formula (Invariant: no unfalsifiable claim)', () => {
  it('no reachable witness produces a delta outside the published band', () => {
    const decisions = ['clean', 'flagged', 'vetoed', 'abstain'] as const;
    const tiers = ['PROBATIONARY', 'EARNING', 'ESTABLISHED', 'AUTONOMOUS', 'VETERAN'];
    let checked = 0;
    for (const hal_decision of decisions) {
      for (const tier of tiers) {
        for (const vest of [true, false]) {
          for (let s = 0; s <= 20; s++) {
            for (const repid of [0, 5, REPID_MIN, 1611, REPID_MAX]) {
              const d = computeDelta({
                hal_score: s / 20,
                hal_decision,
                current_repid: repid,
                agent_tier: tier,
                vesting_cliff_active: vest,
              }).delta_applied;
              expect(d).toBeGreaterThanOrEqual(DELTA_BAND_MIN);
              expect(d).toBeLessThanOrEqual(DELTA_BAND_MAX);
              // And every reachable delta must be ENCODABLE, or the statement cannot
              // be built for a live event.
              expect(() => feltFromDelta(d)).not.toThrow();
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Scoped nullifiers (Invariant 2)
// ---------------------------------------------------------------------------

/**
 * These four pin the DEPRECATED narrow construction (`nullifierScope` +
 * `deriveNullifier`), which is retained only as an off-circuit oracle for the zkp-vault
 * ownership AIR. They are kept because that parity still needs an oracle — NOT because
 * the construction is safe. It is not: the output is one BabyBear element, so the
 * secret is brute-forceable and the nullifier collides at ~63,000 events. The live
 * statement uses the wide construction, and the attacks are demonstrated in
 * `tests/zkp-nullifier-identity.test.ts`.
 */
describe('narrow nullifier (deprecated, parity oracle only)', () => {
  it('the same secret gives DIFFERENT nullifiers in different scopes', () => {
    const secret = 12345n;
    const a = deriveNullifier(secret, nullifierScope(REPID_DELTA_DOMAIN, 'event-1'));
    const b = deriveNullifier(secret, nullifierScope(REPID_DELTA_DOMAIN, 'event-2'));
    expect(a).not.toBe(b);
  });

  it('the same secret and scope give the SAME nullifier — that is what detects a replay', () => {
    const scope = nullifierScope(REPID_DELTA_DOMAIN, 'event-1');
    expect(deriveNullifier(999n, scope)).toBe(deriveNullifier(999n, scope));
  });

  it('the scope is domain-separated, so a nullifier cannot cross verticals', () => {
    const s = nullifierScope(REPID_DELTA_DOMAIN, 'subject-1');
    const h = nullifierScope('hyperdag/health/consent/v1', 'subject-1');
    expect(s).not.toBe(h);
  });

  it('nothing in the construction knows what reputation is — a study id works unchanged', () => {
    expect(() => deriveNullifier(7n, nullifierScope('hyperdag/health/consent/v1', 'study-42'))).not.toThrow();
  });
});

describe('agent commitment', () => {
  it('is domain-separated, so the same agent is uncorrelatable across circuits', () => {
    expect(agentCommitment('a1')).not.toBe(agentCommitment('a1', 'hyperdag/other/v1'));
  });

  it('does not contain the agent id', () => {
    const c = agentCommitment('agent-shofet');
    expect(c).not.toContain('shofet');
    expect(c).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The statement digest — frozen
// ---------------------------------------------------------------------------

describe('canonical digest (KAT — a reorder must break the build)', () => {
  const fixed = {
    domain: REPID_DELTA_DOMAIN,
    agent_commitment: '0x' + '11'.repeat(32),
    identity_commitment: '0x' + '55'.repeat(32),
    // Stored values: integers. repid_after / repid_delta_applied are integer columns
    // and pipeline.ts writes Math.round(...) into both.
    delta_applied: 3,
    score_before: 1611,
    score_after: 1614,
    band_min: DELTA_BAND_MIN,
    band_max: DELTA_BAND_MAX,
    formula_commitment: '0x' + '22'.repeat(32),
    nullifier: '0x' + '66'.repeat(32),
  };

  it('is stable across runs', () => {
    expect(statementDigest(fixed)).toBe(statementDigest(fixed));
  });

  it('FROZEN VALUE — changing the field order or encoding changes this', () => {
    // Not asserting a hand-computed constant: this is pinned to the value the current
    // canonical ordering produces. If this test fails and you did not intend to change
    // the statement format, you reordered statementFelts() and every future proof
    // would have failed verification with no visible cause. If you DID intend it, the
    // circuit spec must change in the same commit.
    //
    // ── FORMAT v2, 2026-08-03. The KAT moved, and here is exactly why. ──
    // Two changes, both to the nullifier's identity binding:
    //   1. `identity_commitment` was ADDED (absorbed after `agent_commitment`). Without
    //      it the nullifier is a bare tag: nothing in the statement says which identity
    //      it belongs to, so no circuit could ever prove the derivation.
    //   2. `nullifier` WIDENED from 32 bits (`0xdeadbeef`) to 248
    //      (`0x`+64 hex). The old width collides between honest events — first
    //      collision at the 62,852nd secret, against 152,084 rows already in
    //      `repid_score_events` [V SQL 2026-08-03].
    // Both change the absorbed field sequence, so the digest necessarily moves. This is
    // safe to do exactly ONCE, now: `repid_zkp_proofs` holds ZERO `REPID_DELTA` rows
    // [V SQL 2026-08-03] and no circuit exists, so nothing on disk or in an AIR is
    // invalidated. The previous v1 value was
    // 0x3216b95a5fa32d7b5a1e2503763512636184daf5318610fd35bf77d56375e0c8.
    // From here it is append-only.
    expect(statementDigest(fixed)).toBe(
      '0x4283a34d6a69a7e608af3e5c471ddaa45b7ed8d8275757b5641daaa774f58166',
    );
  });

  it('every public field is bound — changing any one changes the digest', () => {
    const base = statementDigest(fixed);
    expect(statementDigest({ ...fixed, delta_applied: 2 })).not.toBe(base);
    expect(statementDigest({ ...fixed, score_before: 1610 })).not.toBe(base);
    expect(statementDigest({ ...fixed, score_after: 1613 })).not.toBe(base);
    expect(statementDigest({ ...fixed, domain: 'hyperdag/other/v1' })).not.toBe(base);
    expect(statementDigest({ ...fixed, nullifier: '0xfeedface' })).not.toBe(base);
    expect(statementDigest({ ...fixed, formula_commitment: '0x' + '33'.repeat(32) })).not.toBe(base);
    expect(statementDigest({ ...fixed, agent_commitment: '0x' + '44'.repeat(32) })).not.toBe(base);
    expect(statementDigest({ ...fixed, identity_commitment: '0x' + '77'.repeat(32) })).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Consistency — what this catches today
// ---------------------------------------------------------------------------

describe('consistency: a delta that did not come from the formula', () => {
  it('accepts a delta that follows from its witness', () => {
    expect(checkConsistency(cleanParams())).toBeNull();
  });

  it('THE REGRESSION IT CATCHES: a hand-written delta the formula would not produce', () => {
    // 7 of 11 score-event writers are unguarded, so a delta reaching the ledger
    // without passing through the formula is the failure that actually happens.
    const r = checkConsistency(cleanParams({ deltaApplied: 5, scoreAfter: 1616 }));
    expect(r).toMatch(/does not follow from the witness/);
    expect(r).toMatch(/formula yields 2/);
  });

  it('rejects an out-of-band delta before anything else', () => {
    expect(checkConsistency(cleanParams({ deltaApplied: 50, scoreAfter: 1661 }))).toMatch(
      /outside the published band/,
    );
  });

  it('rejects a score that does not follow from its own delta', () => {
    expect(checkConsistency(cleanParams({ scoreAfter: 1999 }))).toMatch(/does not follow from delta/);
  });

  it('accepts a score stopped at the ceiling', () => {
    expect(
      checkConsistency(
        cleanParams({
          witness: { ...cleanParams().witness, current_repid: REPID_MAX },
          scoreBefore: REPID_MAX,
          scoreAfter: REPID_MAX,
        }),
      ),
    ).toBeNull();
  });

  it('a vetoed event is consistent at -10', () => {
    expect(
      checkConsistency(
        cleanParams({
          witness: { ...cleanParams().witness, hal_decision: 'vetoed' },
          deltaApplied: -10,
          scoreAfter: 1601,
        }),
      ),
    ).toBeNull();
  });

  it('an abstain is consistent at 0 — no truth asserted, no delta', () => {
    expect(
      checkConsistency(
        cleanParams({
          witness: { ...cleanParams().witness, hal_decision: 'abstain' },
          deltaApplied: 0,
          scoreAfter: 1611,
        }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Build + external verification
// ---------------------------------------------------------------------------

describe('building the statement', () => {
  it('produces a complete, self-consistent public statement', () => {
    withSalt(() => {
      const s = buildRepidDeltaStatement(cleanParams());
      expect(s.consistent).toBe(true);
      expect(s.inconsistency).toBeNull();
      expect(s.public.domain).toBe(REPID_DELTA_DOMAIN);
      expect(s.public.statement_digest).toMatch(/^0x[0-9a-f]{64}$/);
      expect(verifyRepidDeltaStatement(s.public).valid).toBe(true);
    });
  });

  it('flags an inconsistent delta but STILL builds the statement', () => {
    // The statement is the record of what was claimed. Refusing to build it would
    // erase the evidence of the inconsistency.
    withSalt(() => {
      const s = buildRepidDeltaStatement(cleanParams({ deltaApplied: 5, scoreAfter: 1616 }));
      expect(s.consistent).toBe(false);
      expect(s.public.statement_digest).toMatch(/^0x/);
    });
  });

  it('leaks no witness value into the public inputs', () => {
    withSalt(() => {
      const p = cleanParams();
      const s = buildRepidDeltaStatement(p);
      const blob = JSON.stringify(s.public);
      expect(blob).not.toContain('0.25'); // hal_score (the witness must not leak)
      expect(blob).not.toContain('clean'); // hal_decision
      expect(blob).not.toContain('ESTABLISHED'); // tier
      expect(blob).not.toContain(p.agentId); // raw identity
      // And not one element of the identity secret.
      for (const f of TEST_IDENTITY_SECRET.felts) expect(blob).not.toContain(f.toString());
    });
  });

  it('binds the nullifier to the identity commitment (Invariant 2, end to end)', () => {
    withSalt(() => {
      const s = buildRepidDeltaStatement(cleanParams());
      expect(s.public.identity_commitment).toBe(TEST_IDENTITY_SECRET.commitment);
      expect(s.public.nullifier).toMatch(/^0x[0-9a-f]{64}$/);
      // The honest-prover recheck: someone holding the secret can confirm the
      // derivation. Someone holding only the commitment cannot — that is the circuit's
      // job and `unproven` says so.
      expect(
        nullifierMatchesSecret({
          secret: TEST_IDENTITY_SECRET,
          domain: REPID_DELTA_DOMAIN,
          scopeLabel: cleanParams().scopeLabel,
          nullifier: s.public.nullifier,
        }),
      ).toBe(true);
    });
  });

  it('the same event in two scopes gives two nullifiers; the same scope gives one', () => {
    withSalt(() => {
      const a = buildRepidDeltaStatement(cleanParams({ scopeLabel: 'score_event:1' }));
      const b = buildRepidDeltaStatement(cleanParams({ scopeLabel: 'score_event:2' }));
      const a2 = buildRepidDeltaStatement(cleanParams({ scopeLabel: 'score_event:1' }));
      expect(a.public.nullifier).not.toBe(b.public.nullifier);
      expect(a.public.nullifier).toBe(a2.public.nullifier);
    });
  });

  it('reports who can link the nullifier, and never claims it is proven', () => {
    withSalt(() => {
      const s = buildRepidDeltaStatement(cleanParams());
      expect(s.unlinkability.proven).toBe(false);
      expect(s.unlinkability.linkable_by.length).toBeGreaterThan(0);
    });
  });
});

describe('external verification — honest about its own limits', () => {
  const built = () => withSalt(() => buildRepidDeltaStatement(cleanParams()));

  it('catches a tampered delta, because the digest binds it', () => {
    const s = built();
    const forged = { ...s.public, delta_applied: 5 };
    const v = verifyRepidDeltaStatement(forged);
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('digest_binds_inputs');
  });

  it('catches a mismatched formula commitment when one is expected', () => {
    const s = built();
    const v = verifyRepidDeltaStatement(s.public, {
      expectedFormulaCommitment: '0x' + '99'.repeat(32),
    });
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('formula_commitment_matches');
  });

  it('catches a replay into another domain', () => {
    const s = built();
    const v = verifyRepidDeltaStatement(s.public, { expectedDomain: 'hyperdag/health/consent/v1' });
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('domain_expected');
  });

  it('REJECTS a narrow nullifier — a colliding tag is a rejectable statement', () => {
    // An outside verifier must be able to refuse the old 32-bit form without reading
    // the source, because at live ledger volume it produces false replay verdicts.
    const s = built();
    const v = verifyRepidDeltaStatement({ ...s.public, nullifier: '0xdeadbeef' });
    expect(v.valid).toBe(false);
    expect(v.failures).toContain('nullifier_is_wide');
  });

  it('NEVER claims to have proven the formula — the list of unknowns is non-empty', () => {
    // The whole overclaim risk of this module. A verifier without the witness cannot
    // know the delta came from the formula; only the circuit can carry that.
    const v = verifyRepidDeltaStatement(built().public);
    expect(v.valid).toBe(true);
    expect(v.unproven.length).toBeGreaterThan(0);
    expect(v.unproven.join(' ')).toMatch(/Plonky3 circuit/);
    // Format v2's new honest limit: the identity binding is ASSERTED, not proven.
    expect(v.unproven.join(' ')).toMatch(/binding is asserted, not proven/);
  });
});

// ---------------------------------------------------------------------------
// Mode gate + honest labelling
// ---------------------------------------------------------------------------

describe('mode gate and labelling', () => {
  it('defaults to off, and only the exact words count', () => {
    const prev = process.env.REPID_DELTA_STATEMENT_MODE;
    try {
      for (const [v, want] of [
        [undefined, 'off'],
        ['', 'off'],
        ['true', 'off'],
        ['1', 'off'],
        ['shadow', 'shadow'],
        ['ON', 'on'],
      ] as const) {
        if (v === undefined) delete process.env.REPID_DELTA_STATEMENT_MODE;
        else process.env.REPID_DELTA_STATEMENT_MODE = v;
        expect(deltaStatementMode()).toBe(want);
      }
    } finally {
      if (prev === undefined) delete process.env.REPID_DELTA_STATEMENT_MODE;
      else process.env.REPID_DELTA_STATEMENT_MODE = prev;
    }
  });

  it('the scheme tag says "statement", never "proof"', () => {
    // A row from here must never be countable as a proven delta. The 56,823 sha256
    // stubs are the reason this is a test and not a comment.
    expect(REPID_DELTA_STATEMENT_SCHEME).toContain('statement');
    expect(REPID_DELTA_STATEMENT_SCHEME).not.toContain('proof');
    expect(REPID_DELTA_STATEMENT_SCHEME).not.toMatch(/plonky|groth/i);
  });

  it('the domain is namespaced and versioned (Invariant 6)', () => {
    expect(REPID_DELTA_DOMAIN).toMatch(/^hyperdag\/repid\/delta\/v\d+$/);
  });
});
