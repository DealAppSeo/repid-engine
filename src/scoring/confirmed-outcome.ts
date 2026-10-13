/**
 * confirmed-outcome.ts — the OFFICIAL score moves ONLY on a CONFIRMED outcome.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHY IT IS A SEPARATE LANE
 * ════════════════════════════════════════════════════════════════════════════════
 * The kernel already owns the vocabulary this layer needs. `kernel/types.ts` defines
 *   SettledBy      = null | 'holdout' | 'known_answer' | 'person'
 *   verdict_label  = 'PROVISIONAL' | 'SETTLED'
 * and `kernel/receipt.ts::buildVerificationLeg` already encodes the one rule that
 * matters: a vote — 3-0 or 2-1 — is PROVISIONAL; only a holdout, a known answer or a
 * person SETTLES. This module REUSES that rule for the reputation score (it does not
 * reinvent it) and adds exactly one settler the kernel receipt does not carry:
 * `counterparty` — a confirming party who is NOT the actor and is independent of it.
 *
 * It is NOT a second copy of `services/outcome-classification.ts::deltaFor`. That
 * module prices x402 economic outcome CLASSES (SUCCESS_AUDITED, FAILURE_AGENT_FAULT)
 * and establishes the asymmetry principle this one also honours — a confident wrong
 * costs strictly more than a success earns — but with shaping constants that are
 * about economic value at risk. This module answers a different, upstream question:
 * *should the official score move at all, and by how much, given how the outcome was
 * CONFIRMED.* The two compose; neither replaces the other.
 *
 * WHY THE KERNEL `SettledBy` TYPE IS NOT EXTENDED. `kernel-receipt/1` is a schema
 * shared with trustshell (shared-vector tests go red if it drifts). Adding
 * 'counterparty' there would be a breaking schema change in another repo's contract.
 * So this module carries its OWN `ConfirmedSettler` superset and maps down to the
 * kernel's when it must; the kernel receipt is left exactly as it is.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE FLAG — default OFF, armed only by Sean
 * ════════════════════════════════════════════════════════════════════════════════
 * `CONFIRMED_OUTCOME_SCORING_ENABLED` (default OFF). While OFF, `updateRepId` behaves
 * EXACTLY as today — this module is never consulted (tests prove it). While ON, an
 * event that carries a `confirmedOutcome` payload is governed by the rules below; an
 * event without that payload is unchanged. Arming it is a deploy-time decision; this
 * lane sets it ON nowhere.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CONFIRMATION MUST BE SERVER-DERIVED (CWE-345 — do not trust the request body)
 * ════════════════════════════════════════════════════════════════════════════════
 * The `settledBy` / `result` / `confidence` / `rubberStampKnownWrong` /
 * `passUnsupportedByReceipt` fields are CALLER-ASSERTED. On their own they move NOTHING.
 * The resolver settles — and the official score moves — ONLY when a `verifiedConfirmation`
 * is present, and that is assembled SERVER-SIDE from a verified source (a kernel receipt,
 * a known-answer record, a signed attestation), NEVER from a request body. Without it the
 * outcome is caller-asserted and FAILS CLOSED (PROVISIONAL, no move) whatever `settledBy`
 * claims. This is the fix for the rubber-stamp the model exists to prevent: a caller
 * could otherwise fake a confirmed-right for gain, or a known-answer rubber-stamp for the
 * heaviest penalty against a victim. NO server-side verifier is wired yet, so the pipeline
 * supplies no `verifiedConfirmation` and every caller-asserted confirmation is held inert.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THREE OUTCOMES, FAIL CLOSED
 * ════════════════════════════════════════════════════════════════════════════════
 * NOT CONFIRMED is its own verdict and it NEVER moves the official score — it is not
 * a pass, and it is not a fail. The resolver never throws into the score path: any
 * dependency that cannot answer (confirmation not server-verified, owner unresolvable,
 * model family unreadable, domain history unreadable) FAILS CLOSED to "unconfirmed, no
 * move". That is the safe direction for a trust product — a false score move is the worst outcome.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * MAGNITUDES LIVE IN THE ENVIRONMENT, NOT IN THIS PUBLIC REPO
 * ════════════════════════════════════════════════════════════════════════════════
 * Every magnitude comes from an env var (see `confirmedParams`), exactly like
 * `config/scoring-params.ts`. The repo keeps the SHAPE of the policy and the
 * structural INVARIANTS between the magnitudes (which encode rules 2 and 5 so a
 * fat-fingered deploy fails loud), and none of the tuning. Production THROWS on an
 * unset parameter rather than guessing; dev placeholders are obviously synthetic.
 */

// ── the flag ──────────────────────────────────────────────────────────────────────
//
// Read as a literal so `scripts/generate-env-registry.mjs` captures it and the
// `check:named-env-vars` guard treats it as a real control. Mirrors the house idiom
// (`=== 'true'`, default OFF) used by CONSTITUTIONAL_AUDIT_ENABLED / DOGFOOD_*.
export function confirmedOutcomeScoringEnabled(): boolean {
  return process.env['CONFIRMED_OUTCOME_SCORING_ENABLED'] === 'true';
}

// ── settlers ────────────────────────────────────────────────────────────────────────

/** The kernel's three objective settlers, plus the one this lane adds. */
export type ConfirmedSettler = 'holdout' | 'known_answer' | 'person' | 'counterparty';

/** What a caller may assert about how an outcome was confirmed. 'vote' never settles. */
export type AssertedSettler = ConfirmedSettler | 'vote' | null;

export type ConfirmedResultKind = 'right' | 'wrong' | 'abstain';

/** The server-side source that established a confirmation. Never a caller string. */
export type ConfirmedVerifiedSource =
  | 'kernel_receipt'
  | 'known_answer_record'
  | 'signed_attestation'
  | 'independent_counterparty';

/**
 * SERVER-DERIVED proof that THIS outcome was actually confirmed (CWE-345 fix).
 *
 * A caller CANNOT produce one. The resolver trusts this field as its contract: it is
 * assembled ONLY by a server-side verifier (a kernel receipt, a known-answer record, a
 * signed attestation) and NEVER from a request body. Its absence means the confirmation
 * is caller-asserted, and the resolver then FAILS CLOSED — a caller-asserted settledBy
 * string never settles, never moves the official score. See the pipeline wiring note:
 * no server-side verifier is wired yet, so the pipeline never supplies one and every
 * caller-asserted confirmation is held inert.
 */
export interface VerifiedConfirmation {
  source: ConfirmedVerifiedSource;
  /** The settler the server source establishes (never 'vote'). Authoritative over `settledBy`. */
  settledBy: ConfirmedSettler;
  /**
   * The result the SERVER established (right/wrong). CWE-345: the caller does NOT get to say whether
   * it was right — the server source does. A caller-asserted `input.result` that disagrees with this
   * is a forgery attempt and fails closed (`result_mismatch`). The verifier only ever sets this from
   * authoritative evidence (e.g. a VERIFIED kernel receipt → 'right', a FAILED one → 'wrong').
   */
  result: ConfirmedResultKind;
}

// ── the input ────────────────────────────────────────────────────────────────────────

export interface ConfirmedOutcomeInput {
  /** The agent whose official score this event would move (the actor). */
  actorAgentId: string;
  /** How the outcome was confirmed, as asserted. A panel 'vote' (incl. a 2-1) never settles. */
  settledBy: AssertedSettler;
  /** The agent's action measured against the confirmed outcome. */
  result: ConfirmedResultKind;
  /** The agent's stated confidence in its claim, 0..1. Heavier loss when wrong AND confident. */
  confidence?: number;
  /**
   * The agent asserted PASS against a KNOWN answer that is actually WRONG — a
   * rubber-stamp. This is the heaviest penalty (rule 2) and bypasses the honest-miss
   * softening — but ONLY once a server-verified known-answer confirmation backs it
   * (`verifiedConfirmation.settledBy === 'known_answer'`). A caller-asserted flag alone
   * never moves the score (CWE-345): the known-answer RECORD is the authority, not this boolean.
   */
  rubberStampKnownWrong?: boolean;
  /**
   * The agent claimed PASS but the receipt does not support it — priced as a CONFIDENT
   * wrong (rule 3), bypassing the honest-miss softening — but ONLY once a server-verified
   * receipt confirmation backs it (`verifiedConfirmation.settledBy === 'holdout'`). A
   * caller-asserted flag alone never moves the score (CWE-345): the RECEIPT is the authority.
   */
  passUnsupportedByReceipt?: boolean;
  /** For settledBy === 'counterparty': the confirming party's agent id (rule 4 independence). */
  counterpartyAgentId?: string | null;
  /** The domain this outcome is in (rules 5 and 6). */
  domain?: string | null;
  /** The miss was self-reported by the agent — it costs LESS than one found later (rule 5). */
  selfReportedMiss?: boolean;
  /** Abstention shortcut; equivalent to result==='abstain'. Abstain is free (rule 3). */
  abstained?: boolean;
  /**
   * SERVER-DERIVED confirmation proof (CWE-345 fix). Present ONLY when a server-side
   * verifier established the confirmation. Absent ⇒ the outcome is caller-asserted and
   * the resolver fails closed (PROVISIONAL, no move) regardless of `settledBy`. The
   * pipeline strips this from any caller payload and never forges one.
   */
  verifiedConfirmation?: VerifiedConfirmation;
}

// ── injected dependencies (all DB-touching work is injected so the resolver is pure) ──

export type OwnerLookupStatus = 'resolved' | 'none' | 'unknown';

export interface ConfirmedOutcomeDeps {
  /**
   * Positively establish the owner principal of an agent. Fail-closed: 'none' and
   * 'unknown' both BLOCK a counterparty confirmation, because distinct owners must be
   * POSITIVELY established — "we could not look" is never "they are independent".
   */
  resolveOwner?: (agentId: string) => Promise<{ status: OwnerLookupStatus; ownerKey: string | null }>;
  /**
   * Read an agent's model family. `null` means absent/unreadable → independence via
   * family cannot be established → fail closed. The production wiring sources this
   * COLUMN-FIRST from `repid_agents.model_family` (the first-class column), falling back
   * to the `capabilities.model_family` jsonb; see `confirmedOutcomeDepsFor`. That column
   * was APPLIED to prod 2026-10-12 but every existing row is NULL, so this reader returns
   * null for every agent until a family is recorded, and the counterparty settler stays refused.
   */
  readModelFamily?: (agentId: string) => Promise<string | null>;
  /**
   * Positively establish whether the agent has a prior confirmed track record in a
   * domain (rule 5). `checked:false` means the history could not be read.
   */
  domainTrackRecord?: (agentId: string, domain: string) => Promise<{ checked: boolean; hasRecord: boolean }>;
  /**
   * The per-domain need multiplier (rule 6): > 1 when demand is unmet, falling toward 1
   * as supply arrives. Applied to GAINS only and capped; never raises the ceiling.
   */
  domainNeedWeight?: (domain: string) => Promise<number>;
}

// ── the result ────────────────────────────────────────────────────────────────────────

export interface IndependenceCheck {
  checked: boolean;
  independent: boolean;
  reason: string;
}

export interface ConfirmedOutcomeResult {
  /** Did an objective settler confirm this outcome? */
  confirmed: boolean;
  /** Reuses the kernel's label: SETTLED only with a settler; a vote alone is PROVISIONAL. */
  verdictLabel: 'PROVISIONAL' | 'SETTLED';
  settledBy: ConfirmedSettler | null;
  /** The delta the official score should move by. 0 when not confirmed or abstain. */
  appliedDelta: number;
  /** True only when the official score should actually move (confirmed && delta !== 0). */
  scoreMoves: boolean;
  /** Rule 5: a first confirmed miss in a NEW domain tightened the band (bounded, not a wipe). */
  bandTightened: boolean;
  /** Rule 6: the per-domain need multiplier actually applied to a gain (1 = none). */
  needMultiplierApplied: number;
  /** Machine- and human-readable trail. */
  reason: string;
  detail: {
    outcome: ConfirmedResultKind | 'unconfirmed';
    /** CWE-345: was the confirmation established SERVER-SIDE? A caller-asserted one is false. */
    serverVerified: boolean;
    independence: IndependenceCheck | null;
    domain: string | null;
    newDomain: boolean | null;
    selfReportedMiss: boolean;
    rubberStampKnownWrong: boolean;
    passUnsupportedByReceipt: boolean;
  };
}

// ── parameters (env-sourced; magnitudes never live in this public repo) ────────────────

export interface ConfirmedOutcomeParams {
  /** SMALL positive gain for a confirmed right. */
  gainBase: number;
  /** Negative base loss for a confirmed wrong (before the confidence weight). */
  lossBase: number;
  /** Extra loss per unit of confidence (positive): a wrong AND confident claim costs more. */
  confidenceLossWeight: number;
  /** Negative; the heaviest — a rubber-stamp of a known-wrong answer. */
  rubberStampPenalty: number;
  /** Negative; a bounded first-confirmed-miss-in-a-new-domain band tighten (not a wipe). */
  bandTightenBase: number;
  /** In (0,1): a self-reported miss costs this fraction of one found later. */
  selfReportMissFactor: number;
  /** >= 1: cap on the per-domain need multiplier applied to GAINS (rule 6). */
  needWeightCap: number;
}

interface Spec {
  env: string;
  min: number;
  max: number;
  dev: number;
}

/**
 * The parameter table. Env names are the SOURCE OF TRUTH; the DEV values are
 * deliberately round, obviously-synthetic placeholders — never the tuned production
 * magnitudes — so a test that leans on them fails loudly rather than passing for the
 * wrong reason, and so a value reused verbatim from here would be worthless as tuning.
 */
const PARAMS: Record<keyof ConfirmedOutcomeParams, Spec> = {
  gainBase: { env: 'REPID_CONFIRMED_GAIN_BASE', min: 0, max: 10000, dev: 5 },
  lossBase: { env: 'REPID_CONFIRMED_LOSS_BASE', min: -10000, max: 0, dev: -15 },
  confidenceLossWeight: { env: 'REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT', min: 0, max: 10000, dev: 40 },
  rubberStampPenalty: { env: 'REPID_CONFIRMED_RUBBER_STAMP_PENALTY', min: -10000, max: 0, dev: -120 },
  bandTightenBase: { env: 'REPID_CONFIRMED_BAND_TIGHTEN_BASE', min: -10000, max: 0, dev: -8 },
  selfReportMissFactor: { env: 'REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR', min: 0, max: 1, dev: 0.5 },
  needWeightCap: { env: 'REPID_CONFIRMED_NEED_WEIGHT_CAP', min: 1, max: 100, dev: 2 },
};

/** Every env var this module requires in production — for the deploy checklist. */
export const REQUIRED_CONFIRMED_ENV: string[] = Object.values(PARAMS).map((p) => p.env).sort();

function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Literal reads (one per var) so `generate-env-registry.mjs` captures each name into
 * the registry and `check:named-env-vars` treats it as a real control. A dynamic
 * `env[spec.env]` would read the same value but leave the name undiscovered.
 */
function rawOf(key: keyof ConfirmedOutcomeParams, env: NodeJS.ProcessEnv): string | undefined {
  switch (key) {
    case 'gainBase': return env['REPID_CONFIRMED_GAIN_BASE'];
    case 'lossBase': return env['REPID_CONFIRMED_LOSS_BASE'];
    case 'confidenceLossWeight': return env['REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT'];
    case 'rubberStampPenalty': return env['REPID_CONFIRMED_RUBBER_STAMP_PENALTY'];
    case 'bandTightenBase': return env['REPID_CONFIRMED_BAND_TIGHTEN_BASE'];
    case 'selfReportMissFactor': return env['REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR'];
    case 'needWeightCap': return env['REPID_CONFIRMED_NEED_WEIGHT_CAP'];
  }
}

function readOne(key: keyof ConfirmedOutcomeParams, env: NodeJS.ProcessEnv, missing: string[]): number {
  const spec = PARAMS[key];
  const raw = rawOf(key, env);
  if (raw === undefined || raw.trim() === '') {
    if (isProduction(env)) {
      missing.push(spec.env);
      return NaN;
    }
    return spec.dev;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
    // An out-of-range value is refused in EVERY environment — a typo must never become
    // a live scoring magnitude silently.
    throw new Error(
      `[confirmed-outcome] ${spec.env}='${raw}' is not a finite number within ` +
        `[${spec.min}, ${spec.max}]. Refusing to score against an incoherent magnitude.`,
    );
  }
  return n;
}

/**
 * Resolve every magnitude. Pure over the env object it is handed. Enforces the
 * structural INVARIANTS that make rules 2 and 5 true BY CONSTRUCTION — a deploy whose
 * magnitudes violate them fails loud here rather than mis-scoring into an append-only
 * ledger (LESSONS 9: when a machine-checked invariant rejects your design, fix the
 * design, not the checker).
 */
export function loadConfirmedParams(env: NodeJS.ProcessEnv = process.env): ConfirmedOutcomeParams {
  const missing: string[] = [];
  const out = {} as ConfirmedOutcomeParams;
  for (const key of Object.keys(PARAMS) as Array<keyof ConfirmedOutcomeParams>) {
    out[key] = readOne(key, env, missing);
  }
  if (missing.length > 0) {
    throw new Error(
      `[confirmed-outcome] REFUSING TO SCORE: ${missing.length} confirmed-outcome magnitude(s) ` +
        `are unset in production — ${missing.join(', ')}. These are deliberately not committed ` +
        `(the repository is public); set them on the repid-engine service before arming ` +
        `CONFIRMED_OUTCOME_SCORING_ENABLED.`,
    );
  }

  // RULE 2: a rubber-stamp of a known-wrong must cost MORE than the last ten confirmed
  // rights combined — even ten MAXIMALLY need-boosted rights (rule 6 can multiply a gain
  // up to gainBase * needWeightCap).
  const tenMaxRights = 10 * out.gainBase * out.needWeightCap;
  if (Math.abs(out.rubberStampPenalty) < tenMaxRights) {
    throw new Error(
      `[confirmed-outcome] |REPID_CONFIRMED_RUBBER_STAMP_PENALTY| (${Math.abs(out.rubberStampPenalty)}) ` +
        `must be >= 10 x gain x needCap (${tenMaxRights}) — rule 2: a rubber-stamp of a known-wrong ` +
        `costs more than the last ten confirmed rights combined.`,
    );
  }
  // RULE 2: a confirmed wrong costs more than a confirmed right (even at zero confidence).
  if (Math.abs(out.lossBase) <= out.gainBase) {
    throw new Error(
      `[confirmed-outcome] |REPID_CONFIRMED_LOSS_BASE| (${Math.abs(out.lossBase)}) must exceed ` +
        `REPID_CONFIRMED_GAIN_BASE (${out.gainBase}) — a confirmed wrong must cost more than a confirmed right.`,
    );
  }
  // RULE 5: a first-miss-in-a-new-domain band tighten must be SMALLER than a full loss —
  // it tightens the band, it does not wipe the score.
  if (Math.abs(out.bandTightenBase) >= Math.abs(out.lossBase)) {
    throw new Error(
      `[confirmed-outcome] |REPID_CONFIRMED_BAND_TIGHTEN_BASE| (${Math.abs(out.bandTightenBase)}) must be ` +
        `< |REPID_CONFIRMED_LOSS_BASE| (${Math.abs(out.lossBase)}) — rule 5: a first miss in a new domain ` +
        `tightens the band, it does not wipe the score.`,
    );
  }
  // RULE 5: a self-reported miss costs LESS than one found later, but is not free.
  if (!(out.selfReportMissFactor > 0 && out.selfReportMissFactor < 1)) {
    throw new Error(
      `[confirmed-outcome] REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR (${out.selfReportMissFactor}) must be ` +
        `strictly between 0 and 1 — a self-reported miss costs less than one found later, but is not free.`,
    );
  }
  return out;
}

let cached: ConfirmedOutcomeParams | null = null;

/** Resolved once per process (deploy-time config, not per-event input). */
export function confirmedParams(): ConfirmedOutcomeParams {
  if (cached === null) cached = loadConfirmedParams();
  return cached;
}

/** Test seam only. */
export function __resetConfirmedParamsCache(): void {
  cached = null;
}

// ── the resolver ─────────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function unconfirmed(
  reason: string,
  independence: IndependenceCheck | null,
  input: ConfirmedOutcomeInput,
  serverVerified = false,
): ConfirmedOutcomeResult {
  return {
    confirmed: false,
    verdictLabel: 'PROVISIONAL',
    settledBy: null,
    appliedDelta: 0,
    scoreMoves: false,
    bandTightened: false,
    needMultiplierApplied: 1,
    reason,
    detail: {
      outcome: 'unconfirmed',
      serverVerified,
      independence,
      domain: input.domain ?? null,
      newDomain: null,
      selfReportedMiss: input.selfReportedMiss === true,
      rubberStampKnownWrong: input.rubberStampKnownWrong === true,
      passUnsupportedByReceipt: input.passUnsupportedByReceipt === true,
    },
  };
}

/**
 * Rule 4 — a confirming counterparty must be POSITIVELY established as independent:
 * not the actor, not a sibling under the same owner, not the same model family. Any
 * input the check cannot read FAILS CLOSED to "not independent".
 */
async function establishIndependence(
  input: ConfirmedOutcomeInput,
  deps: ConfirmedOutcomeDeps,
): Promise<IndependenceCheck> {
  const cp = (input.counterpartyAgentId ?? '').trim();
  if (cp === '') return { checked: false, independent: false, reason: 'counterparty_id_missing' };
  if (cp === input.actorAgentId) return { checked: true, independent: false, reason: 'self_deal_same_agent' };

  // Owner: distinct owners must be POSITIVELY established.
  if (!deps.resolveOwner) return { checked: false, independent: false, reason: 'owner_resolver_absent' };
  let actorOwner: { status: OwnerLookupStatus; ownerKey: string | null };
  let cpOwner: { status: OwnerLookupStatus; ownerKey: string | null };
  try {
    actorOwner = await deps.resolveOwner(input.actorAgentId);
    cpOwner = await deps.resolveOwner(cp);
  } catch (e) {
    return { checked: false, independent: false, reason: `owner_resolve_error:${msg(e)}` };
  }
  if (actorOwner.status !== 'resolved' || cpOwner.status !== 'resolved') {
    return { checked: false, independent: false, reason: `owner_not_established:${actorOwner.status}/${cpOwner.status}` };
  }
  if (!actorOwner.ownerKey || !cpOwner.ownerKey) {
    return { checked: false, independent: false, reason: 'owner_key_missing' };
  }
  if (actorOwner.ownerKey.toLowerCase() === cpOwner.ownerKey.toLowerCase()) {
    return { checked: true, independent: false, reason: 'same_owner_sibling' };
  }

  // Model family: distinct families must be POSITIVELY established.
  if (!deps.readModelFamily) return { checked: false, independent: false, reason: 'model_family_reader_absent' };
  let actorFam: string | null;
  let cpFam: string | null;
  try {
    actorFam = await deps.readModelFamily(input.actorAgentId);
    cpFam = await deps.readModelFamily(cp);
  } catch (e) {
    return { checked: false, independent: false, reason: `model_family_read_error:${msg(e)}` };
  }
  if (!actorFam || !cpFam) {
    // The field is absent/unreadable — same-family independence cannot be established.
    return { checked: false, independent: false, reason: 'model_family_not_checked' };
  }
  if (actorFam.trim().toLowerCase() === cpFam.trim().toLowerCase()) {
    return { checked: true, independent: false, reason: 'same_model_family' };
  }
  return { checked: true, independent: true, reason: 'independent' };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

/**
 * Resolve how — and whether — a confirmed outcome moves the official score. Never
 * throws into the score path: any failure falls through to "unconfirmed, no move".
 */
export async function resolveConfirmedOutcome(
  input: ConfirmedOutcomeInput,
  deps: ConfirmedOutcomeDeps = {},
): Promise<ConfirmedOutcomeResult> {
  try {
    return await resolveInner(input, deps);
  } catch (e) {
    return unconfirmed(`resolver_error:${msg(e)}`, null, input);
  }
}

async function resolveInner(
  input: ConfirmedOutcomeInput,
  deps: ConfirmedOutcomeDeps,
): Promise<ConfirmedOutcomeResult> {
  const p = confirmedParams();

  // RULE 3 (first half): abstain is FREE — zero delta, fully inert, regardless of settler.
  if (input.abstained === true || input.result === 'abstain') {
    return {
      confirmed: false,
      verdictLabel: 'PROVISIONAL',
      settledBy: null,
      appliedDelta: 0,
      scoreMoves: false,
      bandTightened: false,
      needMultiplierApplied: 1,
      reason: 'abstain_free',
      detail: {
        outcome: 'abstain',
        serverVerified: false,
        independence: null,
        domain: input.domain ?? null,
        newDomain: null,
        selfReportedMiss: input.selfReportedMiss === true,
        rubberStampKnownWrong: false,
        passUnsupportedByReceipt: false,
      },
    };
  }

  // RULE 1 — a 'vote' (incl. a 2-1) never settles, verified or not. Kept as a distinct,
  // legible outcome so the rule reads clearly in the audit trail.
  if (input.settledBy === 'vote') {
    return unconfirmed('vote_is_provisional', null, input, false);
  }

  // SECURITY GATE (CWE-345) — the official score moves ONLY on a SERVER-DERIVED verified
  // confirmation. The caller-asserted settledBy / rubberStampKnownWrong /
  // passUnsupportedByReceipt fields are NEVER trusted on their own. Without a
  // verifiedConfirmation (assembled server-side from a kernel receipt / known-answer
  // record / signed attestation — never from a request body) the outcome is
  // caller-asserted and FAILS CLOSED. No server-side verifier is wired yet, so the
  // pipeline supplies none and every caller-asserted confirmation is held inert.
  const vc = input.verifiedConfirmation;
  if (!vc) {
    return unconfirmed('confirmation_not_server_verified', null, input, false);
  }
  const serverSettler = vc.settledBy;

  // RULE 2 (heaviest) — a rubber-stamp of a KNOWN-WRONG answer, established by the
  // known-answer record (the server source), not a caller flag alone. The server source must
  // ALSO establish the result as 'wrong' (`vc.result === 'wrong'`): the heaviest penalty cannot be
  // inflicted off a server confirmation that did not itself find the answer wrong. Fail closed otherwise.
  if (input.rubberStampKnownWrong === true) {
    if (serverSettler !== 'known_answer' || vc.result !== 'wrong') {
      return unconfirmed('rubber_stamp_requires_known_answer_source', null, input, true);
    }
    return settled('known_answer', p.rubberStampPenalty, 'rubber_stamp_known_wrong', {
      outcome: 'wrong',
      independence: null,
      domain: input.domain ?? null,
      newDomain: null,
      selfReportedMiss: false,
      rubberStampKnownWrong: true,
      passUnsupportedByReceipt: false,
    });
  }

  // RULE 3 (second half) — a PASS the receipt does not support is a confident wrong,
  // confirmed by the receipt (the server source). Full confident-wrong penalty. The server source
  // must ALSO establish the result as 'wrong' (`vc.result === 'wrong'`) — here the caller claimed
  // PASS (`input.result` is typically 'right'), so this is the one branch where caller and server
  // DISAGREE legitimately, and the server's 'wrong' is what the penalty rests on. Fail closed otherwise.
  if (input.passUnsupportedByReceipt === true) {
    if (serverSettler !== 'holdout' || vc.result !== 'wrong') {
      return unconfirmed('unsupported_pass_requires_receipt_source', null, input, true);
    }
    const loss = p.lossBase - Math.round(1 * p.confidenceLossWeight);
    return settled('holdout', loss, 'pass_unsupported_by_receipt', {
      outcome: 'wrong',
      independence: null,
      domain: input.domain ?? null,
      newDomain: null,
      selfReportedMiss: false,
      rubberStampKnownWrong: false,
      passUnsupportedByReceipt: true,
    });
  }

  // CWE-345 (result) — the SERVER establishes right/wrong. For the ORDINARY confirmed paths (the
  // two heavy-penalty special branches above have already returned), the caller's asserted
  // `input.result` MUST equal the server's `vc.result`, or it is a forgery attempt → fail closed.
  // Abstain never reaches here (handled before the vc gate), so `input.result` is 'right' or 'wrong'.
  if (input.result !== vc.result) {
    return unconfirmed('result_mismatch', null, input, true);
  }

  // RULE 1 + RULE 4 — the SERVER source establishes the settler. A caller-asserted
  // `settledBy` must AGREE with it (a mismatch is a forgery attempt → fail closed).
  let settler: ConfirmedSettler | null = null;
  let independence: IndependenceCheck | null = null;
  if (serverSettler === 'holdout' || serverSettler === 'known_answer' || serverSettler === 'person') {
    if (input.settledBy !== serverSettler) return unconfirmed('settler_mismatch', null, input, true);
    settler = serverSettler;
  } else {
    // serverSettler === 'counterparty' — ALSO requires the independence check to pass
    // (server-side owner + model-family), on top of the server-verified confirmation.
    if (input.settledBy !== 'counterparty') return unconfirmed('settler_mismatch', null, input, true);
    independence = await establishIndependence(input, deps);
    settler = independence.independent ? 'counterparty' : null;
  }

  if (settler === null) {
    return unconfirmed(`counterparty_not_independent:${independence?.reason ?? 'unknown'}`, independence, input, true);
  }

  // Confirmed. Compute the delta (rules 2, 5, 6).
  if (input.result === 'right') {
    // RULE 6 — per-domain need multiplier, GAINS ONLY, clamped to [1, needWeightCap] so
    // need can only RAISE a gain (never shrink it, never raise the authority ceiling:
    // the pipeline still clamps the score to [10, 10000]).
    let needM = 1;
    if (input.domain && deps.domainNeedWeight) {
      try {
        needM = clamp(await deps.domainNeedWeight(input.domain), 1, p.needWeightCap);
      } catch {
        needM = 1; // fail closed to no boost
      }
    }
    const gain = Math.round(p.gainBase * needM);
    return settled(settler, gain, needM > 1 ? 'confirmed_right_need_boosted' : 'confirmed_right', {
      outcome: 'right',
      independence,
      domain: input.domain ?? null,
      newDomain: null,
      selfReportedMiss: false,
      rubberStampKnownWrong: false,
      passUnsupportedByReceipt: false,
    }, needM);
  }

  // result === 'wrong' — confirmed wrong.
  const conf = clamp(input.confidence ?? 0, 0, 1);
  let loss = p.lossBase - Math.round(conf * p.confidenceLossWeight); // more negative with confidence

  // RULE 5 — a first confirmed miss in a NEW domain tightens the band (bounded), it does
  // not wipe. New domain = positively no prior record, OR history unreadable (don't
  // over-penalize an agent on uncertainty — the trust-product safe direction).
  let newDomain: boolean | null = null;
  let bandTightened = false;
  if (input.domain) {
    let tr = { checked: false, hasRecord: false };
    if (deps.domainTrackRecord) {
      try {
        tr = await deps.domainTrackRecord(input.actorAgentId, input.domain);
      } catch {
        tr = { checked: false, hasRecord: false };
      }
    }
    newDomain = tr.checked ? !tr.hasRecord : true;
    if (newDomain) {
      loss = p.bandTightenBase; // bounded; invariant-guaranteed smaller than a full loss
      bandTightened = true;
    }
  }

  // RULE 5 (last line) — a self-reported miss costs LESS than one found later.
  if (input.selfReportedMiss === true) {
    loss = Math.round(loss * p.selfReportMissFactor);
  }

  return settled(settler, loss, bandTightened ? 'confirmed_miss_new_domain_band_tighten' : 'confirmed_wrong', {
    outcome: 'wrong',
    independence,
    domain: input.domain ?? null,
    newDomain,
    selfReportedMiss: input.selfReportedMiss === true,
    rubberStampKnownWrong: false,
    passUnsupportedByReceipt: false,
  });
}

function settled(
  settledBy: ConfirmedSettler,
  delta: number,
  reason: string,
  // serverVerified is NOT accepted here: a settle only ever happens after the server
  // verification gate, so this helper stamps it true. The caller cannot set it.
  detail: Omit<ConfirmedOutcomeResult['detail'], 'serverVerified'>,
  needMultiplierApplied = 1,
): ConfirmedOutcomeResult {
  return {
    confirmed: true,
    verdictLabel: 'SETTLED',
    settledBy,
    appliedDelta: delta,
    scoreMoves: delta !== 0,
    bandTightened: reason === 'confirmed_miss_new_domain_band_tighten',
    needMultiplierApplied,
    reason,
    detail: { ...detail, serverVerified: true },
  };
}
