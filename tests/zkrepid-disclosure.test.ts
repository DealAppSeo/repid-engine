/**
 * zkrepid-disclosure.test.ts — the FIRST GATED TESTS for the selective-disclosure seam.
 *
 * "Gated" is the operative word. The seam is a STATEMENT, not a proof: there is no Plonky3 circuit
 * for `hyperdag/zkrepid/threshold/v1`, so `provenWithoutSecret` is structurally false and
 * `ZKREPID_DISCLOSURE_MODE=enforce` must REFUSE rather than promote an unproven claim to an access
 * decision. These tests pin that refusal as behaviour, so the day a circuit lands the change is
 * visible as a test change rather than as a silently different runtime.
 *
 * What each block is actually protecting:
 *   preconditions      — the mode flag cannot fail open
 *   nomination         — a verifier cannot nominate a bar that discloses the answer by itself
 *   consent            — no statement without explicit consent; a decline is a value, not a throw
 *   the public surface — THE POINT: the score is not on the wire, and cannot be added by accident
 *   epoch binding      — an undated claim is a bearer certificate
 *   verification       — VERIFIED means "every check I can run passed", never "the bar was met"
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MODE_ENV,
  THRESHOLD_DOMAIN,
  THRESHOLD_PUBLIC_KEYS,
  computeGuards,
  consentToThreshold,
  declineThreshold,
  disclosureMode,
  DisclosureRefusedError,
  nominateThreshold,
  thresholdDigest,
  thresholdScopeLabel,
  verifyThresholdStatement,
  type DisclosureEpoch,
  type ThresholdPublicInputs,
  type ThresholdWitness,
} from '../src/zkrepid/disclosure';
import { identitySecretFromFelts, scopedNullifier } from '../src/zkp/nullifier-identity';
import { CURRENT_FORMULA_PARAMS } from '../src/zkp/repid-delta-statement';
import { REPID_MIN, REPID_MAX } from '../src/scoring/repid-clamp';

// Eight canonical BabyBear elements. Deliberately LARGE and irregular: small values (1..8) would
// make the secret-leak scan's decimal comparison meet real strings by coincidence, and a test that
// only passes with unrealistic secrets tests the wrong thing.
const SECRET_FELTS = [
  1_234_567n, 89_012_345n, 456_789n, 1_999_999_999n,
  777_777_777n, 31_415_926n, 271_828_182n, 161_803_398n,
];

const EPOCH: DisclosureEpoch = {
  label: '2026-08-17',
  start: '2026-08-17T00:00:00.000Z',
  end: '2026-08-18T00:00:00.000Z',
  root: '0x' + 'ab'.repeat(32),
};

function witness(repidScore: number): ThresholdWitness {
  return {
    repidScore,
    identitySecret: identitySecretFromFelts({ felts: SECRET_FELTS, domain: THRESHOLD_DOMAIN }),
  };
}

function request(threshold = 5000) {
  return nominateThreshold({
    threshold,
    verifierId: 'verifier-alpha',
    purpose: 'gating access to a high-trust tool',
    epoch: EPOCH,
  });
}

const MODE_BEFORE = process.env[MODE_ENV];
afterEach(() => {
  if (MODE_BEFORE === undefined) delete process.env[MODE_ENV];
  else process.env[MODE_ENV] = MODE_BEFORE;
});

describe('disclosure mode — cannot fail open', () => {
  it('defaults to shadow when unset', () => {
    delete process.env[MODE_ENV];
    expect(disclosureMode()).toBe('shadow');
  });

  it('treats an unrecognised value as shadow, not as enforce', () => {
    // The failure being prevented: a typo or a half-finished rollout value ('ENFORCE_LATER',
    // 'true', '1') resolving to enforcement. Unrecognised input must land on the safe side.
    for (const v of ['', '  ', 'true', '1', 'ENFORCE_LATER', 'yes', 'shadow-mode']) {
      process.env[MODE_ENV] = v;
      expect(disclosureMode()).toBe('shadow');
    }
  });

  it('reads enforce only from the exact word, case-insensitively', () => {
    for (const v of ['enforce', 'ENFORCE', ' Enforce ']) {
      process.env[MODE_ENV] = v;
      expect(disclosureMode()).toBe('enforce');
    }
  });
});

describe('nomination — the verifier picks the bar, and it must be a real bar', () => {
  it('accepts an integer threshold inside the score clamp', () => {
    const r = request(5000);
    expect(r.threshold).toBe(5000);
    expect(r.epoch.label).toBe('2026-08-17');
  });

  it('refuses a threshold outside the score clamp', () => {
    // A bar below REPID_MIN is met by every possible score, and one above REPID_MAX by none. Either
    // way the "proof" carries no information and the answer is disclosed by the question.
    for (const t of [REPID_MIN - 1, 0, -5, REPID_MAX + 1, 99999]) {
      expect(() => request(t)).toThrow(DisclosureRefusedError);
    }
    expect(() => request(REPID_MIN)).not.toThrow();
    expect(() => request(REPID_MAX)).not.toThrow();
  });

  it('refuses a fractional threshold at the door, naming the real problem', () => {
    // Left to reach the digest, this throws inside `feltFromSigned` as "not an integer", which
    // reads as an encoding bug rather than a bad request.
    try {
      request(4999.5);
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(DisclosureRefusedError);
      expect((e as DisclosureRefusedError).reason).toBe('THRESHOLD_NOT_INTEGER');
    }
  });

  it('refuses a nomination with no epoch, a malformed root, or an inverted window', () => {
    const base = { threshold: 5000, verifierId: 'v', purpose: 'p' };
    expect(() => nominateThreshold({ ...base, epoch: undefined as unknown as DisclosureEpoch })).toThrow(
      /EPOCH_MISSING/,
    );
    expect(() => nominateThreshold({ ...base, epoch: { ...EPOCH, root: '0xdeadbeef' } })).toThrow(
      /EPOCH_ROOT_MALFORMED/,
    );
    expect(() =>
      nominateThreshold({ ...base, epoch: { ...EPOCH, start: EPOCH.end, end: EPOCH.start } }),
    ).toThrow(/EPOCH_WINDOW_INVALID/);
    expect(() => nominateThreshold({ ...base, epoch: { ...EPOCH, label: '  ' } })).toThrow(
      /EPOCH_WINDOW_INVALID/,
    );
  });
});

describe('consent — the holder answers, or refuses, and neither is automatic', () => {
  it('refuses to build a statement without explicit consent', () => {
    // This is the line between disclosure and a read primitive on private data. `consent: false`
    // and a missing `consent` must behave identically.
    for (const consent of [false, undefined as unknown as boolean]) {
      try {
        consentToThreshold({ request: request(), witness: witness(6000), consent });
        throw new Error('expected a refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(DisclosureRefusedError);
        expect((e as DisclosureRefusedError).reason).toBe('CONSENT_MISSING');
      }
    }
  });

  it('returns a decline as a VALUE that carries no score information', () => {
    const d = declineThreshold({
      request: request(5000),
      reason: 'purpose_unacceptable',
      demandReasonable: true,
    });
    expect(d.outcome).toBe('declined');
    expect(d.threshold).toBe(5000);
    expect(d.demandReasonable).toBe(true);
    // A decline must not hint at the answer. If a decline leaked "below" vs "above", declining
    // would itself be the disclosure — and a holder would have no private option at all.
    expect(JSON.stringify(d)).not.toMatch(/met|above|below|score/i);
  });

  it('refuses a fractional witness score', () => {
    // `repid_agents.current_repid` is an integer column. A fractional witness is not the ledger the
    // claim is about, and would silently produce a statement about a number that does not exist.
    try {
      consentToThreshold({ request: request(), witness: witness(6000.5), consent: true });
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as DisclosureRefusedError).reason).toBe('SCORE_NOT_INTEGER');
    }
  });

  it('reports `met` to the HOLDER but keeps it off the public surface', () => {
    delete process.env[MODE_ENV];
    const above = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const below = consentToThreshold({ request: request(5000), witness: witness(4000), consent: true });
    expect(above.met).toBe(true);
    expect(below.met).toBe(false);
    // The holder can see what they are about to hand over. The verifier cannot read it off the
    // statement, because today it would be an unproven assertion dressed as an output.
    expect(Object.keys(above.public)).not.toContain('met');
    expect(JSON.stringify(above.public)).not.toContain('"met"');
  });

  it('produces the SAME public surface whether or not the bar was met', () => {
    delete process.env[MODE_ENV];
    // The strongest available statement of "the score is not on the wire": two holders with the
    // same identity secret, the same epoch and the same nominated bar — one at 4000, one at 6000 —
    // are byte-identical on the wire. If any score information leaked, this would differ.
    const above = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const below = consentToThreshold({ request: request(5000), witness: witness(4000), consent: true });
    expect(below.public).toEqual(above.public);
    expect(below.public.digest).toBe(above.public.digest);
  });
});

describe('the public surface — the score is not on it, and cannot be added by accident', () => {
  it('carries exactly the pinned key set', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(), witness: witness(6000), consent: true });
    expect(Object.keys(s.public).sort()).toEqual([...THRESHOLD_PUBLIC_KEYS].sort());
    // Named absences, so a future widening has to delete an assertion rather than slip past.
    for (const forbidden of ['repid_score', 'score', 'tier', 'agent_id', 'met', 'current_repid']) {
      expect(Object.keys(s.public)).not.toContain(forbidden);
    }
  });

  it('carries the formula version in CLEARTEXT, not only inside a commitment', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(), witness: witness(6000), consent: true });
    // 2026-08-17: a behaviour change shipped without a version bump, and the skew presented as a
    // forged delta — because the version existed only inside a salted hash the verifier cannot
    // open. A verifier needs to know WHICH regime to check against.
    expect(s.public.formula_version).toBe(CURRENT_FORMULA_PARAMS.version);
    expect(s.public.formula_version).toMatch(/^repid-delta-/);
  });

  it('the guard MEASURES the surface — an added score field is caught', () => {
    delete process.env[MODE_ENV];
    const w = witness(6000);
    const s = consentToThreshold({ request: request(), witness: w, consent: true });
    expect(s.guards.witnessHidden).toBe(true);
    expect(s.guards.leaks).toEqual([]);

    // Simulate the mistake that is LIVE in `proof-statement-guard.ts` today: a well-intentioned
    // extra field that publishes the score next to the threshold it is compared against.
    const leaky = { ...s.public, repid_score: w.repidScore } as unknown as ThresholdPublicInputs;
    const g = computeGuards(leaky, w);
    expect(g.witnessHidden).toBe(false);
    expect(g.leaks.join(' ')).toContain('repid_score');
  });

  it('the guard catches a secret field element placed in a public field', () => {
    delete process.env[MODE_ENV];
    const w = witness(6000);
    const s = consentToThreshold({ request: request(), witness: w, consent: true });
    const leaky = {
      ...s.public,
      epoch: { ...s.public.epoch, label: SECRET_FELTS[0]!.toString(10) },
    };
    const g = computeGuards(leaky, w);
    expect(g.witnessHidden).toBe(false);
    expect(g.leaks.join(' ')).toContain('identity-secret field element');
  });

  it('the guard does NOT false-positive when the score happens to equal the threshold', () => {
    // A holder exactly at the bar is a coincidence of values the verifier already knows, not a
    // leak. If this fired, every at-the-bar statement would be refused — and the guard would be
    // switched off, which is worse than a narrower guard.
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(5000), witness: witness(5000), consent: true });
    expect(s.guards.witnessHidden).toBe(true);
    expect(s.met).toBe(true);
  });
});

describe('gating — enforce refuses while nothing is proven', () => {
  it('shadow mode yields a statement that is explicitly not enforceable', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(), witness: witness(6000), consent: true });
    expect(s.mode).toBe('shadow');
    expect(s.enforceable).toBe(false);
    expect(s.guards.provenWithoutSecret).toBe(false);
    expect(s.guards.provenWithoutSecretBecause).toContain('no Plonky3 circuit');
  });

  it('enforce mode THROWS — an unproven statement must never gate access', () => {
    // The whole reason the flag exists in this shape. When a circuit lands, this test changes in
    // the same commit as the circuit, which is exactly the visibility we want.
    process.env[MODE_ENV] = 'enforce';
    try {
      consentToThreshold({ request: request(), witness: witness(6000), consent: true });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(DisclosureRefusedError);
      expect((e as DisclosureRefusedError).reason).toBe('NOT_PROVEN_WITHOUT_SECRET');
    }
  });

  it('enforce mode refuses even when the holder is comfortably above the bar', () => {
    // Fail-closed means the refusal does not depend on the answer. A gate that only refuses the
    // awkward cases is not a gate.
    process.env[MODE_ENV] = 'enforce';
    expect(() =>
      consentToThreshold({ request: request(REPID_MIN), witness: witness(REPID_MAX), consent: true }),
    ).toThrow(/NOT_PROVEN_WITHOUT_SECRET/);
  });
});

describe('digest and nullifier binding', () => {
  it('the digest binds every public field — changing any one changes it', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const { digest, ...preimage } = s.public;
    expect(thresholdDigest(preimage)).toBe(digest);

    const mutations: Array<Omit<ThresholdPublicInputs, 'digest'>> = [
      { ...preimage, threshold: 4999 },
      { ...preimage, formula_version: `${preimage.formula_version}-x` },
      { ...preimage, epoch: { ...preimage.epoch, label: '2026-08-18' } },
      { ...preimage, epoch: { ...preimage.epoch, start: '2026-08-16T00:00:00.000Z' } },
      { ...preimage, epoch: { ...preimage.epoch, end: '2026-08-19T00:00:00.000Z' } },
      { ...preimage, epoch: { ...preimage.epoch, root: '0x' + 'cd'.repeat(32) } },
      { ...preimage, nullifier: '0x' + '11'.repeat(32) },
    ];
    for (const m of mutations) expect(thresholdDigest(m)).not.toBe(digest);
  });

  it('the nullifier is scoped per (threshold, epoch) and derived under this domain', () => {
    delete process.env[MODE_ENV];
    const w = witness(6000);
    const s = consentToThreshold({ request: request(5000), witness: w, consent: true });
    expect(s.public.nullifier).toBe(
      scopedNullifier({
        secret: w.identitySecret,
        domain: THRESHOLD_DOMAIN,
        scopeLabel: thresholdScopeLabel(5000, EPOCH.label),
      }),
    );
    // A different bar or a different epoch is a different scope, so answering two questions does
    // not produce the same tag.
    const other = consentToThreshold({ request: request(4000), witness: w, consent: true });
    expect(other.public.nullifier).not.toBe(s.public.nullifier);
  });

  it('the nullifier does NOT depend on the score — it is an identity tag, not a value tag', () => {
    delete process.env[MODE_ENV];
    const secret = identitySecretFromFelts({ felts: SECRET_FELTS, domain: THRESHOLD_DOMAIN });
    const a = consentToThreshold({
      request: request(5000),
      witness: { repidScore: 4000, identitySecret: secret },
      consent: true,
    });
    const b = consentToThreshold({
      request: request(5000),
      witness: { repidScore: 9000, identitySecret: secret },
      consent: true,
    });
    expect(a.public.nullifier).toBe(b.public.nullifier);
  });

  it('uses a domain distinct from the delta statement family', () => {
    // Invariant 6. Sharing a domain would let a delta statement and a threshold statement be
    // substituted for one another, and would correlate their nullifiers.
    expect(THRESHOLD_DOMAIN).toBe('hyperdag/zkrepid/threshold/v1');
    expect(THRESHOLD_DOMAIN).not.toBe('hyperdag/repid/delta/v1');
  });
});

describe('the doc and the code agree', () => {
  // The seam's honesty lives half in prose — "shadow by default", "enforce refuses", "the score is
  // not on the wire". Prose drifts silently. These assertions are cheap and they are the reason a
  // reader can trust the doc after the circuit lands and the behaviour changes.
  const doc = readFileSync(join(__dirname, '..', 'docs', 'ZKREPID-DISCLOSURE.md'), 'utf8');

  it('the doc names every field of the public surface, and no other', () => {
    for (const k of THRESHOLD_PUBLIC_KEYS) {
      expect({ key: k, inDoc: doc.includes(k) }).toEqual({ key: k, inDoc: true });
    }
  });

  it('the doc names the mode env var and records that enforce refuses', () => {
    expect(doc).toContain(MODE_ENV);
    expect(doc).toContain('NOT_PROVEN_WITHOUT_SECRET');
    expect(doc.toLowerCase()).toContain('shadow');
  });

  it('the doc marks the decline-cost layer as design-only', () => {
    // The one claim most likely to be read as shipped. If someone implements it, this assertion is
    // the thing that makes them update the doc in the same commit.
    expect(doc).toMatch(/DESIGN ONLY|Not implemented/);
  });
});

describe('verification — VERIFIED never means "the bar was met"', () => {
  it('verifies a well-formed statement and still reports what it could not check', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const r = verifyThresholdStatement({
      public: s.public,
      expectedThreshold: 5000,
      expectedFormulaVersion: CURRENT_FORMULA_PARAMS.version,
      now: new Date('2026-08-17T12:00:00.000Z'),
    });
    expect(r.verdict).toBe('VERIFIED');
    expect(r.failures).toEqual([]);
    // Three outcomes, never two. A VERIFIED verdict here must arrive alongside the list of things
    // that were NOT checked, or it reads as a proof of the threshold claim.
    expect(r.notChecked.length).toBeGreaterThan(0);
    expect(r.notChecked.join(' ')).toContain('needs the circuit');
  });

  it('FAILS a tampered digest', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const tampered: ThresholdPublicInputs = { ...s.public, threshold: 100 };
    const r = verifyThresholdStatement({ public: tampered });
    expect(r.verdict).toBe('FAILED');
    expect(r.failures.join(' ')).toContain('digest does not bind');
  });

  it('FAILS when the holder answered a different threshold than the one nominated', () => {
    delete process.env[MODE_ENV];
    // The reason no extra binding field is needed: the nominated bar appears verbatim, so the
    // verifier checks it themselves. This test is that check.
    const s = consentToThreshold({ request: request(1000), witness: witness(6000), consent: true });
    const r = verifyThresholdStatement({ public: s.public, expectedThreshold: 5000 });
    expect(r.verdict).toBe('FAILED');
    expect(r.failures.join(' ')).toContain('different question');
  });

  it('FAILS a stale statement — the epoch is what stops replay', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({ request: request(5000), witness: witness(6000), consent: true });
    const r = verifyThresholdStatement({
      public: s.public,
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(r.verdict).toBe('FAILED');
    expect(r.failures.join(' ')).toContain('stale');
  });

  it('FAILS a statement issued under an unexpected formula regime', () => {
    delete process.env[MODE_ENV];
    const s = consentToThreshold({
      request: request(5000),
      witness: witness(6000),
      consent: true,
      formulaVersion: 'repid-delta-a7',
    });
    const r = verifyThresholdStatement({
      public: s.public,
      expectedFormulaVersion: CURRENT_FORMULA_PARAMS.version,
    });
    expect(r.verdict).toBe('FAILED');
    expect(r.failures.join(' ')).toContain('formula_version');
  });
});
