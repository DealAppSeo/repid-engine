/**
 * kernel/hal-adapter.ts — the ONE join between the real HAL cross-LLM quorum and the kernel's
 * post-gate.
 *
 * THE SEAM THIS CLOSES. The kernel post-gate (gate.ts/decide.ts) asks `deps.halCheck(req)` for a
 * `HalEvidence` ({ verdict: PASS|FLAG|VETO|ABSTAIN, votes, ... }) and the HAL quorum
 * (`src/hal/fact-check.ts::factCheck`) returns a `FactCheckResult` ({ decision: vetoed|flagged|
 * clean|abstain, families_used, ... }). Both are tested, and until now they were NEVER JOINED: the
 * production kernel route wired no `halCheck`, so every `post` read NOT_CHECKED (fail-closed but
 * inert), and no tested adapter mapped one shape onto the other. An adapter that got the mapping
 * wrong would pass every existing suite and FAIL OPEN on a real post — which is exactly what
 * `__tests__/kernel-hal-integration.test.ts` and `__tests__/hal-adapter.test.ts` exist to refuse.
 *
 * THE MAPPING, AND WHY IT FAILS CLOSED (three outcomes, never two):
 *
 *   factCheck decision          kernel verdict   kernel effect on a post
 *   ────────────────────────    ──────────────   ─────────────────────────────────────────────
 *   vetoed                   →  VETO          →  DENY   (hal_vetoed)
 *   flagged + quorum met     →  FLAG          →  DENY   (hal_flagged — flagged content is not cleared)
 *   flagged + quorum NOT met →  ABSTAIN       →  NOT_CHECKED (a degraded/outage flag is "not checked")
 *   clean + quorum met       →  PASS          →  ALLOW  (the ONLY path to a post)
 *   clean + quorum NOT met   →  ABSTAIN       →  NOT_CHECKED (a thin quorum is not a pass)
 *   abstain                  →  ABSTAIN       →  NOT_CHECKED (HAL did not judge it)
 *   anything else/missing    →  ABSTAIN       →  NOT_CHECKED (an unreadable answer is not a pass)
 *
 * A DEFINITIVE verdict (PASS or FLAG) requires a real disjoint-family quorum; otherwise the answer
 * is NOT_CHECKED. This is RULE-3 (evidence outranks the label): factCheck returns `decision:'flagged'`
 * for a TOTAL OUTAGE (hal_score 0.5 neutral fallback, 0 providers) and HOLDS a lone surviving FALSE
 * at `'flagged'` too — neither is a genuine content flag, both are "could not check", so both map to
 * ABSTAIN. Only a flagged backed by >= 2 families is a real FLAG. VETO is the one unconditional block:
 * factCheck only ever emits `'vetoed'` with a quorum (a would-be veto below quorum is downgraded to
 * `'flagged'`), so a veto is always quorum-backed, and the strongest block signal is never softened.
 *
 * "Quorum met" is re-derived HERE, not taken on trust from the upstream `decision`:
 * `families_used >= MIN_DISJOINT_FAMILIES` AND not `degraded`. factCheck's SCORE mode already
 * downgrades a thin `clean` to `abstain` (fact-check.ts F2, 2026-10-07), but the adapter must not
 * depend on an upstream flag (`HAL_QUORUM_FAMILY_AWARE`) staying set, and must still fail closed if
 * that logic ever regresses. The case this catches concretely: the `local_slm` fallback returns
 * `decision:'clean', providers_used:1, degraded:true` with no `families_used` — a single heuristic,
 * not a cross-LLM quorum. It maps to ABSTAIN here, never PASS.
 *
 * settled_by / grounded / same_domain. A fact-check quorum is VOTES ONLY — never a holdout, a known
 * answer or a person — so `settled_by` is always null, which keeps the verification leg PROVISIONAL
 * and `counts_toward_band_restore` false (receipt.ts). grounded/same_domain are reported false: the
 * parametric quorum does not establish same-domain grounding, and false is the conservative value
 * (it can only lower band-restore eligibility, never raise it). A fact-check PASS lets a post
 * through; it must never, on its own, restore a reputation band.
 *
 * NO HAL MODULE IS IMPORTED AT LOAD. `src/hal/fact-check.ts` transitively requires Supabase env at
 * import (billing → config). routes/kernel.ts imports THIS file unconditionally, so pulling HAL in
 * here would make the flag-OFF kernel route newly require that env at boot. The quorum is therefore
 * `require`d lazily, only on the flag-ON path inside the returned HalCheck; the pure mapper below
 * imports nothing and runs with no env. `FactCheckResult`/`FactCheckProviderCfg`/`FactCheckOpts`
 * are type-only imports, erased at compile time.
 */
import type { FactCheckOpts, FactCheckProviderCfg, FactCheckResult } from '../hal/fact-check';
import type { HalCheck, HalEvidence, KernelRequest } from './types';

/**
 * The disjoint-family quorum floor for a `clean` to become a PASS. Matches HAL's own
 * `MIN_QUORUM_FOR_VETO` (fact-check.ts): a decision needs two independent model families to clear OR
 * to veto — one family can do neither. A single family (or none) is NOT_CHECKED, not a pass.
 */
export const MIN_DISJOINT_FAMILIES = 2;

/** What the adapter looked at, so a reviewer can see why a `clean` did or did not become a PASS. */
export interface HalAdapterTrace {
  decision: FactCheckResult['decision'] | 'unreadable';
  families_used: number;
  providers_used: number;
  degraded: boolean;
  quorum_sufficient: boolean;
}

const VERDICT_METHOD = 'hal-fact-check/cross-llm-quorum';

function abstain(method: string, votes: HalEvidence['votes'] = []): HalEvidence {
  return { verdict: 'ABSTAIN', method, votes, settled_by: null, grounded: false, same_domain: false };
}

/**
 * Map each counted (non-ERROR, non-late) provider verdict to a kernel vote. An ERROR provider did
 * not respond, so it is not a vote. The `family` label is the responding PROVIDER's name: the
 * kernel never gates on it (the gate reads `verdict`, which already reflects HAL's family-aware
 * quorum), so this file deliberately does NOT re-derive model families — that truth lives in one
 * place, `fact-check.ts::familyOf`, and importing it here is what the load-time note above forbids.
 */
function votesFrom(result: Partial<FactCheckResult>): HalEvidence['votes'] {
  const raw = Array.isArray(result.verdicts) ? result.verdicts : [];
  const out: HalEvidence['votes'] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    if (v.counted === false) continue; // late / explicitly not counted — not a vote
    if (v.verdict === 'ERROR') continue; // did not respond — not a vote
    const family = String(v.provider ?? 'unknown').slice(0, 64);
    const verdict: 'PASS' | 'FAIL' | 'ABSTAIN' = v.verdict === 'TRUE' ? 'PASS' : v.verdict === 'FALSE' ? 'FAIL' : 'ABSTAIN';
    out.push({ family, verdict });
  }
  return out;
}

/** Count distinct independent families: trust `families_used`, else the `families` array, else 0. */
function familyCount(result: Partial<FactCheckResult>): number {
  if (typeof result.families_used === 'number' && Number.isFinite(result.families_used)) return result.families_used;
  if (Array.isArray(result.families)) return result.families.length;
  return 0;
}

/**
 * PURE. Map a HAL `factCheck()` result onto the kernel's `HalEvidence`. Never throws — an input that
 * is not a readable FactCheckResult is ABSTAIN, not an exception and never a PASS. This is the
 * instrument the non-vacuity tests break on purpose: swap it for a version that passes `flagged` or
 * a thin `clean` and the integration suite fails open, which is the proof it is a real instrument.
 */
export function halEvidenceFromFactCheck(result: unknown, trace?: (t: HalAdapterTrace) => void): HalEvidence {
  if (!result || typeof result !== 'object') {
    trace?.({ decision: 'unreadable', families_used: 0, providers_used: 0, degraded: true, quorum_sufficient: false });
    return abstain(VERDICT_METHOD);
  }
  const r = result as Partial<FactCheckResult>;
  const decision = r.decision;
  const families = familyCount(r);
  const providers = typeof r.providers_used === 'number' ? r.providers_used : 0;
  const degraded = r.degraded === true;
  const votes = votesFrom(r);

  if (decision !== 'vetoed' && decision !== 'flagged' && decision !== 'clean' && decision !== 'abstain') {
    // An unreadable or unexpected shape is NOT_CHECKED, never a pass (RULE-4; three outcomes).
    trace?.({ decision: 'unreadable', families_used: families, providers_used: providers, degraded, quorum_sufficient: false });
    return abstain(VERDICT_METHOD, votes);
  }

  const quorumSufficient = families >= MIN_DISJOINT_FAMILIES && !degraded;
  trace?.({ decision, families_used: families, providers_used: providers, degraded, quorum_sufficient: quorumSufficient });

  // VETO is unconditional: factCheck only emits 'vetoed' with a real quorum, and the strongest
  // block signal is never softened to NOT_CHECKED.
  if (decision === 'vetoed') return { verdict: 'VETO', method: VERDICT_METHOD, votes, settled_by: null, grounded: false, same_domain: false };

  // abstain is NOT_CHECKED outright.
  if (decision === 'abstain') return abstain(VERDICT_METHOD, votes);

  // clean and flagged are DEFINITIVE only with a real disjoint-family quorum. Without it — a thin
  // quorum, a degraded run, a total outage's neutral 'flagged' — the answer is NOT_CHECKED.
  if (!quorumSufficient) return abstain(VERDICT_METHOD, votes);
  if (decision === 'flagged') return { verdict: 'FLAG', method: VERDICT_METHOD, votes, settled_by: null, grounded: false, same_domain: false };
  return { verdict: 'PASS', method: VERDICT_METHOD, votes, settled_by: null, grounded: false, same_domain: false };
}

/** The quorum function this adapter drives. Injectable so a test can supply a deterministic double. */
export type FactCheckFn = (
  deliverable: string,
  providers: FactCheckProviderCfg[],
  opts?: FactCheckOpts,
) => Promise<FactCheckResult>;

export interface KernelHalCheckOpts {
  /** The quorum. Defaults to the real `factCheck` (lazy-required). A test injects a double. */
  factCheck?: FactCheckFn;
  /** The provider set, or a thunk for it. Defaults to `buildFactCheckProviders()` from env, per call. */
  providers?: FactCheckProviderCfg[] | (() => FactCheckProviderCfg[]);
  /** Options forwarded to `factCheck`. */
  factCheckOpts?: FactCheckOpts;
  /**
   * How to obtain the content to fact-check from a kernel request.
   *
   * THE KERNEL REQUEST CARRIES ONLY `args_hash`, NEVER CONTENT (types.ts) — so over the HTTP kernel
   * route there is nothing to check and the default returns null, which makes HAL ABSTAIN and the
   * post stay blocked (NOT_CHECKED). A caller that wraps a real post tool with the deliverable in
   * hand supplies this resolver and gets a live verdict. A resolver is never allowed to turn "no
   * content" into a pass: a null/empty deliverable is ABSTAIN.
   */
  resolveDeliverable?: (request: KernelRequest) => string | null | undefined;
}

/**
 * Build a `HalCheck` for the kernel that consults the real HAL quorum and maps the answer through
 * `halEvidenceFromFactCheck`. Flag-gated at the wiring site (routes/kernel.ts, KERNEL_HAL_ENABLED);
 * this factory itself is unconditional and side-effect-free until its returned function is called.
 */
export function makeKernelHalCheck(opts: KernelHalCheckOpts = {}): HalCheck {
  const resolve = opts.resolveDeliverable ?? (() => null);
  return async (request: KernelRequest): Promise<HalEvidence> => {
    const deliverable = resolve(request);
    if (typeof deliverable !== 'string' || deliverable.trim() === '') {
      // No content reached the kernel (only a hash). NOT a pass — the post is not cleared.
      return abstain('hal-fact-check/no-deliverable');
    }
    // Lazy-require the heavy quorum module ONLY on the flag-on path (see the load-time note above).
    const hal = opts.factCheck ? null : (require('../hal/fact-check') as typeof import('../hal/fact-check'));
    const factCheckFn: FactCheckFn = opts.factCheck ?? hal!.factCheck;
    const providers = typeof opts.providers === 'function'
      ? opts.providers()
      : opts.providers ?? (hal ?? (require('../hal/fact-check') as typeof import('../hal/fact-check'))).buildFactCheckProviders();
    const result = await factCheckFn(deliverable, providers, opts.factCheckOpts ?? {});
    return halEvidenceFromFactCheck(result);
  };
}
