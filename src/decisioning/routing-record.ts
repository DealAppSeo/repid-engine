/**
 * routing-record.ts — the per-decision record that makes a routing flip MEASURABLE.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `ENGINE_LLM_PROXY` is one variable away from sending the 12-agent fleet through this
 * engine's broker. When it flips, the question on day one will be "did free-first
 * routing actually hold, and if not, which provider took the request and why?"
 *
 * Today that question has no answer, because of what IS and ISN'T recorded:
 *
 *   - `anfis_routing_logs` (22 columns, verified against information_schema 2026-08-03)
 *     records the WINNER and the ANFIS counterfactual: static_provider, static_tier,
 *     static_reason, anfis_provider, anfis_tier, anfis_conf, cost_usdc, latency_ms,
 *     success, n_providers.
 *   - It records NOTHING about the losers. There is no column for the candidate chain,
 *     no per-candidate skip reason, and no cost class. `n_providers` is a COUNT.
 *
 * So a row saying "static picked groq" cannot distinguish "groq was first and healthy"
 * from "six providers were silently unusable and groq was the only one left" — and it
 * can never show that a PAID provider was reached while a FREE one was still available,
 * because free-vs-paid is not in the table at all.
 *
 * This module builds that missing half: the ordered candidate list, each candidate's
 * cost class, and the specific reason each one was passed over. It is what turns a flip
 * from a mystery into a measurement.
 *
 * WHAT IT IS NOT
 * --------------
 * INERT. Pure function, no I/O, no DB write, no env read, no routing effect. It
 * DESCRIBES a decision that has already been made; it never influences one. It carries
 * no ANFIS parameters and no scoring-formula terms — only provider names, positions,
 * cost classes and skip reasons.
 *
 * Persisting these records is deliberately NOT done here: `anfis_routing_logs` has no
 * column to hold them, and adding one is prod DDL (Sean-gated). See "PERSISTENCE" at
 * the bottom for the exact seam.
 */

export type CandidateSkipReason =
  | 'chosen'
  | 'excluded_by_caller'
  | 'disabled_by_config'
  | 'no_key'
  | 'unhealthy'
  | 'cap_hit'
  | 'not_reached';

export interface RoutingCandidate {
  provider: string;
  /** 0-based position in the chain as the router would walk it. */
  position: number;
  tier: '0a' | '1' | 'slm';
  /** 'free' | 'paid' | 'unpriced' — from providers/cost-class.ts. 'unpriced' is NOT 'free'. */
  costClass: string;
  outcome: CandidateSkipReason;
}

export interface RoutingRecord {
  /** Provider that won, or 'none' when the chain was exhausted. */
  chosen: string;
  chosenTier: string;
  /** The router's own reason code (RouteDecision.reason). */
  reason: string;
  /** Every candidate the router could have used, in walk order, with why it lost. */
  candidates: RoutingCandidate[];
  /**
   * TRUE when a 'paid' candidate sits ahead of a candidate that was 'free' AND still
   * usable. This is the free-first violation, stated as data rather than as a belief.
   */
  freeFirstViolated: boolean;
  /** The specific (paid, free) pair that proves the violation, when there is one. */
  freeFirstViolation?: { paidProvider: string; freeProvider: string; note: string };
  /** Cost class of the winner — the single field a flip's cost impact hinges on. */
  chosenCostClass: string;
  /** Providers removed before selection by LLM_DISABLED_PROVIDERS. */
  disabledByConfig: string[];
  /** Providers that could never have been tried because no key resolved. */
  keyless: string[];
  /**
   * Providers a FRESH probe verdict says are dead (providers/provider-liveness.ts).
   *
   * Observational: this is what the hand-maintained `LLM_DISABLED_PROVIDERS` list
   * would need to contain to match reality. Comparing the two answers "is the
   * manual list current?" from traffic instead of from memory. Empty unless
   * PROVIDER_LIVENESS_MODE is set and the ledger has been refreshed.
   */
  deadByProbe?: string[];
}

export interface BuildRoutingRecordInput {
  chosen: string;
  chosenTier: string;
  reason: string;
  /** Chain in walk order: [{ provider, tier }]. Order is the whole point — preserve it. */
  chain: { provider: string; tier: '0a' | '1' | 'slm' }[];
  /** Providers the caller excluded up front (retry loop's exclusion set). */
  excluded?: string[];
  disabledByConfig?: string[];
  keyless?: string[];
  /** Fresh-DEAD probe verdicts. Observational only — see RoutingRecord.deadByProbe. */
  deadByProbe?: string[];
  /** Providers the router walked past because health said no. */
  unhealthy?: string[];
  /** Providers skipped because their spend cap was hit. */
  capHit?: string[];
  /** Injected so this module owns no pricing knowledge: provider → 'free'|'paid'|'unpriced'. */
  classify: (provider: string) => string;
}

/**
 * A candidate is "usable" when nothing structural stopped it — it was skipped only
 * because the walk never got that far, or it won. A free provider that was itself
 * unhealthy/keyless/capped does NOT prove a free-first violation; the router was right
 * to pass it. Only a REACHABLE free provider behind a paid one is a real finding.
 */
function isUsable(outcome: CandidateSkipReason): boolean {
  return outcome === 'chosen' || outcome === 'not_reached';
}

/**
 * Build the record. Pure and total — every input has a defined default, so a partially
 * observed decision still produces a record rather than throwing inside a routing path.
 */
export function buildRoutingRecord(input: BuildRoutingRecordInput): RoutingRecord {
  const excluded = new Set(input.excluded ?? []);
  const disabled = new Set(input.disabledByConfig ?? []);
  const keyless = new Set(input.keyless ?? []);
  const unhealthy = new Set(input.unhealthy ?? []);
  const capHit = new Set(input.capHit ?? []);

  const candidates: RoutingCandidate[] = input.chain.map((c, position) => {
    let outcome: CandidateSkipReason;
    if (c.provider === input.chosen) outcome = 'chosen';
    else if (disabled.has(c.provider)) outcome = 'disabled_by_config';
    else if (keyless.has(c.provider)) outcome = 'no_key';
    else if (capHit.has(c.provider)) outcome = 'cap_hit';
    else if (unhealthy.has(c.provider)) outcome = 'unhealthy';
    else if (excluded.has(c.provider)) outcome = 'excluded_by_caller';
    else outcome = 'not_reached';

    return {
      provider: c.provider,
      position,
      tier: c.tier,
      costClass: input.classify(c.provider),
      outcome,
    };
  });

  // Free-first check: walk the chain in order; the first time a PAID candidate appears
  // ahead of a still-usable FREE candidate, the invariant is broken.
  let violation: RoutingRecord['freeFirstViolation'];
  for (let i = 0; i < candidates.length && !violation; i++) {
    const paid = candidates[i];
    if (!paid || paid.costClass !== 'paid' || !isUsable(paid.outcome)) continue;
    for (let j = i + 1; j < candidates.length; j++) {
      const free = candidates[j];
      if (!free || free.costClass !== 'free' || !isUsable(free.outcome)) continue;
      violation = {
        paidProvider: paid.provider,
        freeProvider: free.provider,
        note:
          `paid '${paid.provider}' is at chain position ${paid.position}, ahead of usable ` +
          `free '${free.provider}' at position ${free.position}`,
      };
      break;
    }
  }

  const record: RoutingRecord = {
    chosen: input.chosen,
    chosenTier: input.chosenTier,
    reason: input.reason,
    candidates,
    freeFirstViolated: violation !== undefined,
    chosenCostClass: input.classify(input.chosen),
    disabledByConfig: [...disabled],
    keyless: [...keyless],
  };
  if (violation) record.freeFirstViolation = violation;
  // Omitted entirely when empty so an unrefreshed ledger reads as "no observation"
  // rather than as "observed, nothing dead" — those are different facts.
  if (input.deadByProbe && input.deadByProbe.length > 0) record.deadByProbe = [...input.deadByProbe];
  return record;
}

/** Compact one-line form for logs — the full record as JSON is too wide for a log grep. */
export function summarizeRoutingRecord(r: RoutingRecord): string {
  const chain = r.candidates
    .map((c) => `${c.provider}[${c.costClass[0]}:${c.outcome === 'chosen' ? 'WON' : c.outcome}]`)
    .join(' > ');
  const flag = r.freeFirstViolated ? ` FREE_FIRST_VIOLATED(${r.freeFirstViolation?.note})` : '';
  return `chosen=${r.chosen}/${r.chosenTier} class=${r.chosenCostClass} reason=${r.reason}${flag} chain: ${chain}`;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────────────
 * PERSISTENCE (NOT done here — needs prod DDL, which is Sean-gated)
 * ─────────────────────────────────────────────────────────────────────────────────────
 * `anfis_routing_logs` has a `notes JSONB` column and no candidate/cost-class columns.
 * The cheapest honest seam is to write this record into `notes` under a `routing_record`
 * key — additive, no DDL, no schema risk. That belongs in the module that already owns
 * the insert (src/services/anfis-shadow-persist.ts), which is outside this change's
 * fence and currently has unmerged PRs against it.
 *
 * Until that lands, these records are computed and (behind ROUTER_DECISION_RECORD) logged,
 * but not queryable. That is a KNOWN GAP, stated here rather than papered over: a flip
 * measured only from logs is measurable but not aggregatable.
 */
