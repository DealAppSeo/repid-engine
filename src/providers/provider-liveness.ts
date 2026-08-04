/**
 * provider-liveness.ts — let the ROUTER learn what the PROBE already knows.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP, EXACTLY
 * ════════════════════════════════════════════════════════════════════════════════
 * This codebase already knows how to ask "is this provider credential alive?" —
 * `src/services/provider-key-probe.ts`, with a deliberately conservative
 * LIVE/DEAD/INCONCLUSIVE mapping. Two things consume it:
 *
 *   1. BYOK custody — refuses to store a USER's key it has not seen work.
 *   2. The ops CLI  — prints a report for a HUMAN to read.
 *
 * Nothing consumes it on behalf of the FLEET's own keys at routing time. The
 * router's only liveness inputs are:
 *
 *   keylessProviders()  — presence. Cannot see a key that is set but dead.
 *   disabledProviders() — a hand-maintained `LLM_DISABLED_PROVIDERS` env string.
 *   providers/health.ts — reactive: three real failures before it opens a breaker.
 *
 * So the loop is closed by a person: run the probe, read the report, hand-edit an
 * env var, redeploy. `disabledProviders()` says so in its own words — "liveness is
 * not knowable from config, so the operator states it."
 *
 * It IS knowable. It is knowable by the probe that already exists. This module is
 * the missing edge between the two, and nothing more: it holds probe verdicts and
 * answers "which providers should the walk skip?".
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT JUST "AUTO-DISABLE THE DEAD ONES"
 * ════════════════════════════════════════════════════════════════════════════════
 * Because a narrower fleet is a different failure, not an absence of one. HAL
 * counts INDEPENDENT MODEL FAMILIES, not hosts — the probe table carries a
 * `family` column precisely so two Llama endpoints cannot be miscounted as two
 * votes. Silently excluding dead providers can therefore trade a loud failure
 * (requests erroring on a dead provider) for a quiet one (a verdict still returned,
 * on too few independent families to mean what it claims).
 *
 * So exclusion is refused outright when it would take independent family width
 * below `PROVIDER_LIVENESS_MIN_FAMILIES`. In that case the dead providers stay in
 * the chain and the assessment says why — a loud, attributable failure beats a
 * quiet narrowing of the quorum. That is the same reasoning the probe module uses
 * when it declines to call a flaky provider dead.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * CONSERVATISM, INHERITED
 * ════════════════════════════════════════════════════════════════════════════════
 *   DEAD          → may exclude (the credential was actually rejected)
 *   INCONCLUSIVE  → NEVER excludes. A timeout is not evidence about a key.
 *   LIVE          → never excludes.
 *   stale verdict → NEVER excludes. A key rotated back to life must not stay
 *                   excluded because of something observed hours ago.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * SHADOW FIRST — THIS CHANGES WHO SERVES REAL TRAFFIC
 * ════════════════════════════════════════════════════════════════════════════════
 * `off` (default) is byte-identical to today: `livenessExcludedProviders()`
 * returns nothing. `shadow` computes and reports what it WOULD exclude so the
 * question "would this have caught the HuggingFace outage before it took the
 * broker down?" is answered from recorded traffic rather than from argument.
 * Only `enforce` actually removes a provider from the walk.
 *
 * SECRETS: this module never sees, stores, or logs a key VALUE. It reads env vars
 * only to hand them straight to the probe, which has its own secrets discipline,
 * and it retains nothing but a provider name, a status and a timestamp.
 */

import {
  PROVIDER_PROBES,
  probeProviderKey,
  independentFamilies,
  probeFor,
  type KeyProbeStatus,
} from '../services/provider-key-probe';

export type LivenessMode = 'off' | 'shadow' | 'enforce';

export const LIVENESS_MODE_ENV = 'PROVIDER_LIVENESS_MODE';
export const LIVENESS_TTL_ENV = 'PROVIDER_LIVENESS_TTL_MS';
export const LIVENESS_MIN_FAMILIES_ENV = 'PROVIDER_LIVENESS_MIN_FAMILIES';

/**
 * How long a verdict is trusted. Beyond this it is ignored entirely rather than
 * treated as bad news — see the staleness rule above.
 */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Floor on independent (non-reseller) model families after exclusion.
 *
 * 3 is a CONSERVATIVE PLACEHOLDER, not a measured constant: it matches the
 * "3+ reachable providers" quorum the routing/HAL design refers to. It is a knob
 * on purpose, and every assessment reports the resulting width whether or not the
 * floor binds — so a wrong floor shows up as data instead of silently mis-gating.
 */
export const DEFAULT_MIN_FAMILIES = 3;

export function parseLivenessMode(raw: string | undefined | null): LivenessMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

export function livenessMode(): LivenessMode {
  return parseLivenessMode(process.env[LIVENESS_MODE_ENV]);
}

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface LivenessVerdict {
  provider: string;
  status: KeyProbeStatus;
  /** Safe to log — carries no key material. */
  detail: string;
  /** epoch ms when this verdict was observed. */
  observedAt: number;
}

/**
 * In-memory ledger. Deliberately NOT persisted: a verdict is only trusted for
 * `TTL`, so surviving a restart would buy nothing but a chance to act on
 * something stale.
 */
const ledger = new Map<string, LivenessVerdict>();

export function recordVerdict(v: LivenessVerdict): void {
  ledger.set(v.provider.toLowerCase(), { ...v, provider: v.provider.toLowerCase() });
}

export function getVerdicts(): LivenessVerdict[] {
  return [...ledger.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

export function clearVerdicts(): void {
  ledger.clear();
}

/** Providers with a FRESH, DEAD verdict. The only exclusion candidates there are. */
export function deadProviders(now: number = Date.now(), ttlMs?: number): string[] {
  const ttl = ttlMs ?? positiveIntEnv(LIVENESS_TTL_ENV, DEFAULT_TTL_MS);
  return getVerdicts()
    .filter((v) => v.status === 'DEAD' && now - v.observedAt <= ttl)
    .map((v) => v.provider);
}

export interface LivenessAssessment {
  mode: LivenessMode;
  /** Fresh-DEAD providers — what exclusion WOULD target. */
  deadCandidates: string[];
  /** What is actually removed from the walk. Empty unless mode==='enforce'. */
  excluded: string[];
  /** True when the family floor blocked an otherwise-valid exclusion. */
  withheldForFamilyFloor: boolean;
  /** Independent families remaining if `deadCandidates` were excluded. */
  familiesAfter: string[];
  minFamilies: number;
  reason: string;
}

/**
 * Decide what to skip. Pure over its inputs — no probing, no I/O, no clock of its
 * own — so the rule is exhaustively testable without network or fake timers.
 *
 * @param chainProviders every provider in the routing walk, in order.
 * @param dead           fresh-DEAD providers (from `deadProviders()`).
 */
export function assessLiveness(input: {
  chainProviders: string[];
  dead: string[];
  mode?: LivenessMode;
  minFamilies?: number;
}): LivenessAssessment {
  const mode = input.mode ?? livenessMode();
  const minFamilies = input.minFamilies ?? positiveIntEnv(LIVENESS_MIN_FAMILIES_ENV, DEFAULT_MIN_FAMILIES);

  const chain = input.chainProviders.map((p) => p.toLowerCase());
  const deadSet = new Set(input.dead.map((p) => p.toLowerCase()));
  // Only providers actually in the walk matter. A dead key for a provider this
  // request would never reach is not this decision's business.
  const deadCandidates = chain.filter((p) => deadSet.has(p));

  const survivors = chain.filter((p) => !deadSet.has(p));
  const familiesAfter = independentFamilies(survivors);

  const base = {
    mode,
    deadCandidates,
    familiesAfter,
    minFamilies,
  };

  if (deadCandidates.length === 0) {
    return { ...base, excluded: [], withheldForFamilyFloor: false, reason: 'no fresh DEAD verdict for any provider in the chain' };
  }

  // The floor is checked in EVERY mode, so a shadow run reports the same verdict
  // enforce would reach. A shadow that measured a different rule than the one
  // being considered would be measuring nothing.
  if (familiesAfter.length < minFamilies) {
    return {
      ...base,
      excluded: [],
      withheldForFamilyFloor: true,
      reason:
        `refusing to exclude ${deadCandidates.join(', ')} — independent family width would fall to ` +
        `${familiesAfter.length} (${familiesAfter.join('/') || 'none'}), below the floor of ${minFamilies}. ` +
        `A dead provider that errors loudly is preferable to a quorum quietly too narrow to mean what it claims.`,
    };
  }

  return {
    ...base,
    excluded: mode === 'enforce' ? deadCandidates : [],
    withheldForFamilyFloor: false,
    reason:
      mode === 'enforce'
        ? `excluding ${deadCandidates.join(', ')} on a fresh DEAD probe verdict; ${familiesAfter.length} independent families remain`
        : `would exclude ${deadCandidates.join(', ')} (mode=${mode}); ${familiesAfter.length} independent families would remain`,
  };
}

/**
 * The router-facing answer. Returns [] unless mode is `enforce`, so wiring this
 * in is inert until someone opts in.
 */
export function livenessExcludedProviders(chainProviders: string[], now: number = Date.now()): string[] {
  if (livenessMode() !== 'enforce') return [];
  return assessLiveness({ chainProviders, dead: deadProviders(now) }).excluded;
}

/** One greppable line per assessment, for counting a shadow run from logs. */
export function livenessLogLine(a: LivenessAssessment): string {
  const verb = a.excluded.length > 0 ? 'EXCLUDED' : a.withheldForFamilyFloor ? 'WITHHELD' : 'WOULD-EXCLUDE';
  return (
    `[provider-liveness] ${verb} mode=${a.mode} ` +
    `dead=${a.deadCandidates.join('|') || 'none'} families=${a.familiesAfter.length} — ${a.reason}`
  );
}

/**
 * Probe every fleet key that is PRESENT in env and record the verdicts.
 *
 * Never called on the routing hot path — routing reads the ledger, it does not
 * fill it. Drive this from an ops script or a scheduled runner.
 *
 * A provider whose env var is absent is left with NO verdict rather than a DEAD
 * one: "not configured" is `keylessProviders()`'s job, and recording it as dead
 * here would double-count it and muddy the family-width arithmetic.
 */
export async function refreshFleetLiveness(
  now: () => number = Date.now,
  probe: typeof probeProviderKey = probeProviderKey,
): Promise<LivenessVerdict[]> {
  const results = await Promise.all(
    PROVIDER_PROBES.map(async (p) => {
      const key = process.env[p.env];
      if (!key) return null;
      const r = await probe(p.provider, key);
      const v: LivenessVerdict = {
        provider: p.provider,
        status: r.status,
        detail: r.detail,
        observedAt: now(),
      };
      recordVerdict(v);
      return v;
    }),
  );
  return results.filter((r): r is LivenessVerdict => r !== null);
}

/** Family a provider buys, or null for a reseller/unknown. Convenience for reporting. */
export function familyOf(provider: string): string | null {
  const p = probeFor(provider);
  if (!p || p.family === 'mixed') return null;
  return p.family;
}
