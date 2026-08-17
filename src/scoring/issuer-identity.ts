/**
 * ISSUER IDENTITY AT THE HAL WRITE SITE — additive, flag-gated, default OFF.
 * OUTPUT_PATH: src/scoring/issuer-identity.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * A HAL verdict moves an agent's RepID and names nobody as its author.
 * `counterparty_agent_id` is NULL on all 147,723 HAL_SCORE_EVENT rows in
 * production [VERIFIED live 2026-08-17], so a veto that turns out to be wrong
 * has no issuer to charge and a veto that turns out to be right has no issuer
 * to credit. Issuer staking is blocked on that, not on the economics.
 *
 * This module decides — purely — whether a score-event row may name its issuer,
 * and returns the exact column values to merge into the insert payload. It sets
 * no delta, applies no policy, and reads no database.
 *
 * WHAT IS AND IS NOT AVAILABLE AT THE WRITE SITE
 * ----------------------------------------------
 * `runScoreEvent` (src/scoring/pipeline.ts) has:
 *
 *   AVAILABLE, and it is not the issuer
 *     input.provider_used / llm_provider  — the provider of the ANSWER BEING
 *       JUDGED. Present on 144,277 rows. Recording it as the issuer would
 *       attribute every verdict to its own defendant.
 *     input.agent_id                      — the SUBJECT. Recording it as the
 *       issuer violates repid_score_events_counterparty_not_self (23514).
 *     signals.providers_used / hal_mode   — the issuer's EVIDENCE, not its
 *       identity.
 *
 *   NOT AVAILABLE, at all
 *     Any identifier for the actor that issued the verdict. `ScoreEventInput`
 *     carries no issuer field, no DID, no service identity; the HAL evaluator
 *     is called in-process and returns none. There is no row in `repid_agents`
 *     known to stand for the HAL pipeline — five rows have HAL-ish names and
 *     choosing one would be a guess in a foreign-keyed column.
 *
 * So the identifier is NOT INVENTED HERE. It is supplied by the operator via
 * `HAL_ISSUER_AGENT_ID`, and when it is absent this module refuses and the row
 * is written exactly as it is today. An operator-supplied identity is a fact
 * someone is accountable for; a derived one would be fiction that later reads
 * as evidence.
 *
 * THE ZERO THAT IS NOT A ZERO
 * ---------------------------
 * `pipeline.ts` computes `Number(signals.providers_used ?? 0)` for the quorum
 * gate, and persists that into `metadata.quorum_providers_used`. Measured live:
 * EVERY row storing 0 is `hal_mode='extractor-fallback'` (1,967) or `hal_mode`
 * NULL (476) — i.e. the field was ABSENT and got coalesced. Not one row where a
 * fact-check quorum ran and genuinely consulted zero providers. So the stored 0
 * means "not recorded" 100% of the time, in the exact place a cost function
 * would read "consulted nothing" and charge for it.
 *
 * `normaliseProvidersUsed` therefore returns **null for absent** and never
 * coalesces. It is a separate read of the raw signal on purpose: the quorum
 * gate's own `?? 0` is load-bearing scoring behaviour and is deliberately NOT
 * touched by this change.
 *
 * COUPLING — READ BEFORE FLIPPING THE FLAG
 * ----------------------------------------
 * `HAL_ISSUER_IDENTITY_ENABLED=true` makes the writer name `counterparty_role`
 * and `issuer_providers_used_n`, which do not exist until
 * `migrations/2026-08-17-issuer-identity-and-verdict-evidence.sql` is applied.
 * Flipping the flag first makes EVERY HAL score-event insert fail. The coupling
 * runs one way: the migration alone is inert.
 *
 * A configured id that is not a row in `repid_agents` fails 23503 on every
 * insert. This module validates SHAPE only — existence needs I/O and this stays
 * pure — so that is an operator precondition, stated rather than silently
 * absorbed. It fails loud by design; a fallback to "no issuer" here would hide
 * a misconfiguration behind rows that look normal.
 *
 * CALLER AND CONSUMER (LESSONS 3)
 * -------------------------------
 * Caller: `runScoreEvent` in src/scoring/pipeline.ts.
 * Consumer: **NONE YET.** No cost function reads `counterparty_role =
 * 'verdict_issuer'`, because it cannot be validated against production data
 * that does not exist. This wiring makes NEW rows carry the fact so that a
 * future consumer has something to read. Until that consumer exists this is a
 * recorder, not an enforcement path, and must not be described as one.
 *
 * PURITY: no I/O, no DB, no network. Env is read through the caller-supplied
 * `env` argument so the resolver is testable without mutating process.env.
 */

/** Column values to merge into a `repid_score_events` insert payload. */
export interface IssuerIdentityFields {
  counterparty_agent_id: string;
  counterparty_role: 'verdict_issuer';
  issuer_providers_used_n: number | null;
}

/**
 * Why an issuer was not recorded. Every refusal carries one — an empty reason
 * reads as "nothing there" and the next reader fills the silence (LESSONS 1).
 */
export type IssuerRefusalReason =
  /** The flag is off. This is the default and is not a fault. */
  | 'disabled'
  /** Flag on, but no issuer identifier configured. A misconfiguration. */
  | 'no_issuer_configured'
  /** Configured value is not a uuid, so it cannot satisfy the FK. */
  | 'issuer_id_malformed'
  /**
   * The configured issuer IS the subject of this event. Writing it would
   * violate repid_score_events_counterparty_not_self (23514) on every such
   * insert. Self-judgement is not recordable as a two-party fact.
   */
  | 'issuer_is_subject';

export type IssuerIdentityResult =
  | { recorded: true; fields: IssuerIdentityFields }
  | { recorded: false; reason: IssuerRefusalReason };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The count of verification providers the issuer consulted, or null when the
 * issuer did not report one.
 *
 * THREE OUTCOMES, NOT TWO:
 *   null  NOT RECORDED — absent, non-numeric, non-finite, or negative.
 *   0     MEASURED ZERO — the issuer reports it consulted nothing.
 *   >= 1  that many answered.
 *
 * A non-integer is floored rather than refused: a fractional provider count is
 * a producer bug, and losing the whole observation to it would be a worse
 * trade than recording the floor. A NEGATIVE count is refused outright — it
 * cannot be a floor of anything real, and the column's CHECK would reject it.
 *
 * ONLY a number or a numeric string is accepted. An ARRAY is refused even
 * though `Number([])` is 0 and `Number([3])` is 3: the persisted provider list
 * is the corrupt shape `src/hal/provider-width.ts` refuses (empty lists, and a
 * count smuggled into a name slot), and coercing an empty one would turn "the
 * list was never populated" into "the issuer measured zero providers" — the
 * fail-OPEN direction, and precisely the confusion this function exists to end.
 */
export function normaliseProvidersUsed(raw: unknown): number | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.floor(n);
}

export function issuerIdentityEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.HAL_ISSUER_IDENTITY_ENABLED === 'true';
}

/**
 * Decide whether this row may name its issuer.
 *
 * Order of checks is the order of precedence, and it is deliberate: `disabled`
 * is reported before `no_issuer_configured` so an operator who has not opted in
 * is never told they are misconfigured.
 */
export function resolveIssuerIdentity(args: {
  /** The agent the verdict is ABOUT — repid_score_events.agent_id. */
  subjectAgentId: string;
  /**
   * The raw `providers_used` signal off the HAL result. Pass it through
   * UNTOUCHED — do not pre-coalesce absence to 0; see the module header.
   */
  rawProvidersUsed: unknown;
  env?: NodeJS.ProcessEnv;
}): IssuerIdentityResult {
  const env = args.env ?? process.env;

  if (!issuerIdentityEnabled(env)) return { recorded: false, reason: 'disabled' };

  const configured = (env.HAL_ISSUER_AGENT_ID ?? '').trim();
  if (!configured) return { recorded: false, reason: 'no_issuer_configured' };
  if (!UUID_RE.test(configured))
    return { recorded: false, reason: 'issuer_id_malformed' };

  // Case-insensitive: Postgres compares uuids by value, so two spellings of the
  // same uuid are the same row and the CHECK would reject them just the same.
  if (configured.toLowerCase() === (args.subjectAgentId ?? '').trim().toLowerCase())
    return { recorded: false, reason: 'issuer_is_subject' };

  return {
    recorded: true,
    fields: {
      counterparty_agent_id: configured,
      counterparty_role: 'verdict_issuer',
      issuer_providers_used_n: normaliseProvidersUsed(args.rawProvidersUsed),
    },
  };
}
