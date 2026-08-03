/**
 * HAL MEASUREMENT INTEGRITY — a dead key is not a quality regression.
 * OUTPUT_PATH: src/hal/measurement-integrity.ts
 *
 * THE INCIDENT THIS PREVENTS
 * --------------------------
 * The golden-math tripwire went red because a provider key had died. It reported as a scoring
 * failure, and someone spent real time hunting a bug in the math that did not exist. The same shape
 * shows up in the live data: `hal_runner_results` holds 266 rows with `gen_failed = true`, and
 * `hal_providers_used` is EMPTY for 43 rows of one measurement run — cases that reached zero
 * providers still landed in the same table as cases that reached three.
 *
 * A number produced when the instrument was broken is not a worse number. It is not a number. The
 * distinction is:
 *
 *   ENVIRONMENT  — the instrument could not be assembled. Dead key, expired token, rate limit,
 *                  network failure, fewer families reached than configured. Says nothing about HAL.
 *   QUALITY      — the instrument was intact and HAL's judgements were scored against ground truth.
 *                  Only this class is a measurement of HAL, and only this class may move a trend.
 *
 * This module classifies which one happened and produces failure text that names it explicitly, so a
 * red test tells the reader which of the two they are looking at in its first line.
 *
 * PURITY: no I/O, no env reads, no network. Classification from evidence the caller already collected.
 * This module never retries a provider, never alters a decision, threshold or veto.
 */
import { ConfigurationWidth, describeWidth } from './measurement-ruler';

/** Why a provider call failed, as far as the error text lets us tell. */
export type ProviderErrorKind =
  /** 401/403/invalid-key — the key is dead, revoked, or absent. Environment. */
  | 'auth'
  /** 402/quota/billing — the account is out of credit. Environment. */
  | 'quota'
  /** 429 — throttled. Environment. */
  | 'rate-limit'
  /** timeout / connection reset / DNS. Environment. */
  | 'network'
  /** 5xx from the provider. Environment. */
  | 'provider-error'
  /** Reached the provider, got a response, could not use it (bad JSON, empty completion). */
  | 'malformed-response'
  /** Could not be classified. Treated as environment — the safe direction. */
  | 'unknown';

/** One provider's participation in one case (or in a whole run, if the caller aggregates). */
export interface ProviderAttempt {
  provider: string;
  /** Model family (brand-level: llama / qwen / deepseek). The unit the quorum counts. */
  family: string;
  ok: boolean;
  /** Raw error text, when !ok. Used for classification only. */
  error?: string;
  /** HTTP status, when known. Takes precedence over text matching. */
  httpStatus?: number;
}

/** A single environment-class problem found in a run. */
export interface EnvironmentFault {
  kind: ProviderErrorKind | 'insufficient-families' | 'no-providers-reached';
  /** Provider label, when the fault is attributable to one. */
  provider?: string;
  family?: string;
  detail: string;
}

/** The verdict on whether a run is entitled to produce a quality number. */
export type IntegrityVerdict =
  | { measurable: true; faults: EnvironmentFault[]; summary: string }
  | { measurable: false; faults: EnvironmentFault[]; summary: string };

/** Error kinds that mean "the instrument was not assembled", i.e. never a quality signal. */
const ENVIRONMENT_KINDS: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'auth',
  'quota',
  'rate-limit',
  'network',
  'provider-error',
  'unknown',
]);

/**
 * Classify a provider failure. Status code wins when present; otherwise match the error text.
 *
 * Defaults to `unknown`, which is treated as ENVIRONMENT. That direction is deliberate: mistaking an
 * environment fault for a quality regression sends someone hunting a bug that does not exist (the
 * incident above), whereas mistaking a quality problem for an environment fault merely withholds a
 * number until the run is repeated. One wastes days; the other wastes minutes.
 */
export function classifyProviderError(error?: string, httpStatus?: number): ProviderErrorKind {
  if (typeof httpStatus === 'number') {
    if (httpStatus === 401 || httpStatus === 403) return 'auth';
    if (httpStatus === 402) return 'quota';
    if (httpStatus === 429) return 'rate-limit';
    if (httpStatus >= 500) return 'provider-error';
  }
  const s = (error ?? '').toLowerCase();
  if (!s) return httpStatus === undefined ? 'unknown' : 'provider-error';
  if (/\b(401|403)\b|unauthor|forbidden|invalid[_ -]?api[_ -]?key|invalid[_ -]?token|api key not|no api key|missing api key|authentication/.test(s))
    return 'auth';
  if (/\b402\b|quota|insufficient[_ -]?(balance|credit|funds)|billing|payment required|exceeded your current/.test(s))
    return 'quota';
  if (/\b429\b|rate[_ -]?limit|too many requests|slow down/.test(s)) return 'rate-limit';
  if (/timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|network|fetch failed|dns/.test(s))
    return 'network';
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|overloaded/.test(s)) return 'provider-error';
  if (/json|parse|malformed|empty (response|completion)|unexpected token/.test(s)) return 'malformed-response';
  return 'unknown';
}

/** True iff this failure kind means the instrument was broken rather than HAL being wrong. */
export function isEnvironmentKind(kind: ProviderErrorKind): boolean {
  return ENVIRONMENT_KINDS.has(kind);
}

/**
 * Decide whether a run may produce a quality number.
 *
 * A run is NOT quality-measurable when:
 *   1. no provider was reached at all, or
 *   2. any provider failed for an environment reason (dead key, quota, throttle, network, 5xx,
 *      unclassifiable), or
 *   3. fewer families were reached than were configured — the quorum HAL's veto depends on was
 *      narrower than the instrument being described, so the resulting number belongs to a different
 *      ruler than the one the operator thinks they are holding.
 *
 * `malformed-response` alone does not block: the provider was reachable and answered, so the run is a
 * legitimate observation of HAL handling a bad upstream response. It is still reported as a fault.
 */
export function assessRunIntegrity(args: {
  attempts: readonly ProviderAttempt[];
  width: ConfigurationWidth;
}): IntegrityVerdict {
  const { attempts, width } = args;
  const faults: EnvironmentFault[] = [];

  for (const a of attempts) {
    if (a.ok) continue;
    const kind = classifyProviderError(a.error, a.httpStatus);
    faults.push({
      kind,
      provider: a.provider,
      family: a.family,
      detail: describeProviderFault(a, kind),
    });
  }

  const reached = attempts.filter((a) => a.ok);
  if (attempts.length > 0 && reached.length === 0) {
    faults.push({
      kind: 'no-providers-reached',
      detail: `all ${attempts.length} provider attempts failed — no judgement was obtained from any model`,
    });
  }

  if (width.familiesMin < width.familiesConfigured) {
    faults.push({
      kind: 'insufficient-families',
      detail:
        `configured for ${width.familiesConfigured} families but at least one case was judged with only ` +
        `${width.familiesMin} — the quorum was narrower than the instrument described`,
    });
  }

  const blocking = faults.filter(
    (f) =>
      f.kind === 'no-providers-reached' ||
      f.kind === 'insufficient-families' ||
      (isEnvironmentKind(f.kind as ProviderErrorKind) && f.kind !== 'unknown') ||
      f.kind === 'unknown',
  );

  const measurable = blocking.length === 0;
  return {
    measurable,
    faults,
    summary: measurable
      ? `instrument intact ${describeWidth(width)}${faults.length ? ` (${faults.length} non-blocking fault(s))` : ''}`
      : summarizeBlocking(blocking, width),
  };
}

function describeProviderFault(a: ProviderAttempt, kind: ProviderErrorKind): string {
  const where = `${a.provider}${a.family ? ` (family ${a.family})` : ''}`;
  const status = a.httpStatus !== undefined ? ` HTTP ${a.httpStatus}` : '';
  switch (kind) {
    case 'auth':
      return `${where}: credential rejected${status} — the key is dead, revoked, or absent. This is an ENVIRONMENT fault, not a HAL quality signal.`;
    case 'quota':
      return `${where}: out of quota/credit${status} — the account cannot serve requests. ENVIRONMENT fault.`;
    case 'rate-limit':
      return `${where}: rate-limited${status} — throttled, not wrong. ENVIRONMENT fault.`;
    case 'network':
      return `${where}: network failure${status} — unreachable. ENVIRONMENT fault.`;
    case 'provider-error':
      return `${where}: provider-side error${status}. ENVIRONMENT fault.`;
    case 'malformed-response':
      return `${where}: reachable but returned an unusable response${status} — HAL's handling of this IS observable.`;
    default:
      return `${where}: unclassified failure${status} (${a.error ?? 'no error text'}) — treated as ENVIRONMENT, because guessing "quality" sends someone hunting a bug that may not exist.`;
  }
}

function summarizeBlocking(blocking: EnvironmentFault[], width: ConfigurationWidth): string {
  const deadKeys = blocking.filter((f) => f.kind === 'auth' || f.kind === 'quota');
  const lead = deadKeys.length
    ? `${deadKeys.length} provider credential(s) dead or out of quota (${deadKeys
        .map((f) => f.provider ?? '?')
        .join(', ')})`
    : `${blocking.length} environment fault(s)`;
  return `instrument NOT intact: ${lead}; ${describeWidth(width)}`;
}

/**
 * Thrown instead of reporting a quality number from a broken instrument.
 *
 * The message leads with ENVIRONMENT FAILURE and states in its first line that this is not a quality
 * regression, because the first line is the part that gets read when a test goes red.
 */
export class EnvironmentFaultError extends Error {
  readonly faults: EnvironmentFault[];
  constructor(verdict: IntegrityVerdict, context?: string) {
    super(formatIntegrityFailure(verdict, context));
    this.name = 'EnvironmentFaultError';
    this.faults = verdict.faults;
  }
}

/**
 * The failure text. Structured so the environment/quality distinction is the first thing visible and
 * the remediation is concrete (which key, which provider) rather than "check your setup".
 */
export function formatIntegrityFailure(verdict: IntegrityVerdict, context?: string): string {
  const head = `ENVIRONMENT FAILURE — this is NOT a HAL quality regression.`;
  const what = context ? `\n  While: ${context}` : '';
  const why = `\n  Why no number was produced: ${verdict.summary}`;
  const lines = verdict.faults.map((f) => `\n    - [${f.kind}] ${f.detail}`).join('');
  const dead = verdict.faults.filter((f) => f.kind === 'auth' || f.kind === 'quota');
  const fix = dead.length
    ? `\n  Fix: restore or replace the credential(s) for ${dead
        .map((f) => f.provider ?? '?')
        .join(', ')}, then re-run. Do NOT investigate HAL's scoring — nothing here indicates a scoring defect.` +
      `\n  Note: a key can be PRESENT and DEAD. Probe it with a real call; do not merely check that the variable is set.`
    : `\n  Fix: repair the instrument (see faults above), then re-run. Do NOT treat this as a scoring defect.`;
  return `${head}${what}${why}${lines}${fix}`;
}

/**
 * THE GATE for the environment question. Call before recording any accuracy number.
 * Throws `EnvironmentFaultError` when the instrument was not intact.
 */
export function assertQualityMeasurable(
  args: { attempts: readonly ProviderAttempt[]; width: ConfigurationWidth },
  context?: string,
): void {
  const verdict = assessRunIntegrity(args);
  if (!verdict.measurable) throw new EnvironmentFaultError(verdict, context);
}

/**
 * Count distinct families among successful attempts. The observed width for a case — the number that
 * belongs in `ConfigurationWidth.familiesMin`/`familiesMax`, as opposed to the number configured.
 */
export function observedFamilyWidth(attempts: readonly ProviderAttempt[]): number {
  return new Set(attempts.filter((a) => a.ok && a.family).map((a) => a.family)).size;
}
