/**
 * zkp-statement-registry.test.ts
 *
 * Two of these run against the REAL `@hyperdag/proof-verifier` WASM and pin
 * properties nobody had measured before 2026-08-21. The rest pin the rule that
 * keeps a future statement from being mistaken for A1 — a rule that becomes
 * unenforceable the moment it is broken once.
 *
 * The proof fixture is the same synthetic one `zkp-proof-verifier-crosscheck`
 * uses: a real STARK over a fabricated witness, per the #376 fence.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  A1,
  RESERVED_ARITY_A1,
  STATEMENT_REGISTRY,
  arityIsAvailable,
  boundFieldsFor,
  knownFieldsFor,
  resolveStatement,
  unverifiedClaimKeys,
} from '../src/zkp/statement-registry';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const verifier: { init_panic_hook(): void; verify_proof(inputJson: string): string } =
  require('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js');

const FIX_DIR = join(__dirname, 'fixtures', 'zkp');
const meta = JSON.parse(
  readFileSync(join(FIX_DIR, 'leaf-rangecheck.synthetic.json'), 'utf8'),
) as { statement: Record<string, unknown>; proof_file: string };
const PROOF_B64 = readFileSync(join(FIX_DIR, meta.proof_file)).toString('base64');
const HONEST = meta.statement as { agent_id: string; tier: string; repid_score: number; threshold: number };

function verify(statement: Record<string, unknown>): { verified: boolean; error: string | null } {
  return JSON.parse(verifier.verify_proof(JSON.stringify({ proof_bytes: PROOF_B64, statement })));
}

beforeAll(() => verifier.init_panic_hook());

describe('A1 binds its two numbers individually, not just their difference', () => {
  /**
   * MEASURED 2026-08-21. This was never checked, and it is the property the
   * claim relation most plausibly fails to have.
   *
   * A1 proves `repid_score > threshold` via a range check on
   * `repid_score - threshold - 1`. That is a statement about a DIFFERENCE. If
   * only the difference were bound, a proof of "2280 over a threshold of 999"
   * would equally prove "10000 over a threshold of 8719" — the same gap, an
   * enormously better-sounding claim, and a complete break of what the proof is
   * for.
   */
  it('REJECTS difference-preserving shifts of the (score, threshold) pair', () => {
    const gap = HONEST.repid_score - HONEST.threshold;
    for (const shift of [1, 100, 1000, 7720]) {
      const shifted = {
        ...HONEST,
        repid_score: HONEST.repid_score + shift,
        threshold: HONEST.threshold + shift,
      };
      expect(shifted.repid_score - shifted.threshold).toBe(gap); // same gap...
      expect(verify(shifted).verified).toBe(false); // ...and still refused.
    }
  });

  it('still ACCEPTS the honest statement, so the rejections above mean something', () => {
    // Without this, a verifier that rejected everything would pass the test above.
    expect(verify(HONEST).verified).toBe(true);
  });
});

describe('a statement cannot carry its own identity', () => {
  /**
   * MEASURED 2026-08-21. The verifier's parser is strict about MISSING fields
   * and types, and silent about UNKNOWN ones. So a version tag written into the
   * statement is worth exactly what `tier` is worth: nothing.
   *
   * This is the finding the whole registry exists because of. If it ever stops
   * being true — if the verifier starts rejecting unknown fields — that is a
   * BREAKING change for every caller, and this test is where it surfaces.
   */
  it('ignores an unknown field entirely, whatever it claims', () => {
    expect(verify({ ...HONEST, statement_version: 'A1' }).verified).toBe(true);
    // The same proof, asserting it proves something else. Still accepted.
    expect(verify({ ...HONEST, statement_version: 'A2-totally-different' }).verified).toBe(true);
    expect(verify({ ...HONEST, risk_tier: 'ATTESTED', policy_version: 'anything' }).verified).toBe(true);
  });

  it('is strict about the fields it does know — so the silence above is specific, not general', () => {
    for (const drop of ['agent_id', 'tier', 'threshold'] as const) {
      const { [drop]: _omitted, ...rest } = HONEST;
      const r = verify(rest as Record<string, unknown>);
      expect(r.verified).toBe(false);
      expect(r.error).toMatch(/missing field/);
    }
    const wrongType = verify({ ...HONEST, repid_score: String(HONEST.repid_score) });
    expect(wrongType.verified).toBe(false);
    expect(wrongType.error).toMatch(/invalid type/);
  });

  it('flags keys the verifier will ignore, so a caller cannot mistake them for constraints', () => {
    expect(unverifiedClaimKeys('A1', { ...HONEST })).toEqual([]);
    expect(unverifiedClaimKeys('A1', { ...HONEST, statement_version: 'A1' })).toEqual(['statement_version']);
    // `tier` is known-but-unbound and deliberately NOT flagged: flagging it on
    // every call would train readers to ignore this function.
    expect(unverifiedClaimKeys('A1', { tier: 'VETERAN' })).toEqual([]);
  });
});

describe('the arity reservation — the rule that keeps A2 from impersonating A1', () => {
  /**
   * A1 cannot gain a version field, so two statements can only be told apart
   * structurally. Arity is the one signal a verifier sees before semantics.
   */
  it('reserves 18 public values to A1, permanently', () => {
    expect(A1.arity).toBe(RESERVED_ARITY_A1);
    expect(arityIsAvailable(RESERVED_ARITY_A1)).toBe(false);
  });

  it('leaves every other arity available to a future statement', () => {
    for (const n of [17, 19, 20, 34]) expect(arityIsAvailable(n)).toBe(true);
  });

  it('holds no two statements at the same arity', () => {
    // The invariant, asserted over the registry rather than over A1 alone, so
    // adding A2 at arity 18 fails HERE rather than in production.
    const arities = Object.values(STATEMENT_REGISTRY).map((s) => s.arity);
    expect(new Set(arities).size).toBe(arities.length);
  });
});

describe('what a relying party may believe', () => {
  it('names exactly the three bound fields', () => {
    expect(boundFieldsFor('A1').sort()).toEqual(['agent_id', 'repid_score', 'threshold']);
  });

  it('does NOT list tier as bound, matching the measured verifier behaviour', () => {
    // Substituting tier verifies — pinned in zkp-proof-verifier-crosscheck. A
    // registry that claimed otherwise would be worse than no registry.
    expect(verify({ ...HONEST, tier: 'VETERAN' }).verified).toBe(true);
    expect(boundFieldsFor('A1')).not.toContain('tier');
    expect(A1.fields['tier']).toBe('REQUIRED_UNBOUND');
  });

  it('lists tier among the known fields, because omitting it is refused', () => {
    // Both halves are load-bearing: you must supply it, and you must not believe
    // it. Either half alone misleads.
    expect(knownFieldsFor('A1')).toContain('tier');
  });
});

describe('resolving a stored proof to a statement', () => {
  it('resolves a recorded id', () => {
    expect(resolveStatement('A1')).toBe(A1);
  });

  it('returns null — NOT A1 — for an unrecorded or unknown statement', () => {
    // Defaulting to A1 is precisely how a future A2 proof would silently become
    // a RepID claim. An absence must stay an absence.
    for (const v of [null, undefined, '', 'A2', 'plonky3_range_check']) {
      expect(resolveStatement(v)).toBeNull();
    }
  });

  it('does not resolve from the scheme, which names machinery rather than meaning', () => {
    // Two different statements can share a proof system. `scheme` cannot be the
    // identity, which is exactly why a separate recorded id is needed.
    expect(A1.schemes).toContain('plonky3_range_check');
    expect(resolveStatement('plonky3_range_check')).toBeNull();
  });
});
