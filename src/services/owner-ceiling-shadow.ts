/**
 * owner-ceiling-shadow.ts — what would happen if the OWNER's limits bound the
 * agent's, measured without changing a single decision.
 *
 * THE GAP THIS MEASURES. `services/x402-gate.ts#decideAuthority` decides how much
 * an agent may move using the agent's own tier and RepID, and nothing else. There
 * is no path by which the human who owns an agent can lower what that agent may
 * spend — `conservator_address` is read and written to the audit row, but it
 * never enters the decision, and it is this engine's own signer anyway. Sean's
 * requirement is the opposite: "the agent subject to the rules and settings of
 * the user who owns it".
 *
 * WHY SHADOW, AND NOT THE GATE ITSELF. Both signed-ownership tables are EMPTY in
 * production (MEASURED 2026-08-17). Enforcing an owner-derived ceiling today
 * would deny the majority of agents on the strength of a table nobody has written
 * to yet, and would prove nothing about the policy. `CustodyShadow` in
 * trinity-ecosystem is the pattern this follows, including the part that matters
 * most: it EXPECTS to be uninformative at first and says so, so that a run of
 * `no_owner` is read as "adoption is zero", never as "the two agree".
 *
 * THREE PROPERTIES:
 *   1. It never alters the decision. The caller acts on the real verdict; the
 *      shadow verdict is only recorded.
 *   2. It never throws into the caller. Every path is caught, and a failure is
 *      recorded as `error` rather than propagated.
 *   3. It cannot widen. `attenuateCeiling` is a min(), so the shadow ceiling is
 *      never above the real one and `shadow_looser` is not a representable
 *      outcome. That is asserted by a test, not just by reading.
 *
 * THE NUMBER THIS EXISTS TO PRODUCE is not the agreement rate — it is
 * `would_deny_if_owner_required`: how many authorised transactions belong to
 * agents whose owner cannot be established. That is the cost of switching
 * enforcement on, and it is a fact about coverage, not about ceilings.
 */
import { logAgentEvent, buildAgentLogRow } from '../engine/agent-log';
import { ownerPerTxCap, resolveOwner, type OwnerResolution } from './agent-owner-resolver';
import type { AuthorityDecision } from './x402-gate';

/**
 * Default OFF. Reading the flag per call (not at import) so a deployment can turn
 * observation on without a restart, and so tests can flip it.
 *
 * While this is off the module performs NO reads and NO writes: it is inert, and
 * the report that ships with it must say so rather than implying data exists.
 */
export function ownerCeilingShadowEnabled(): boolean {
  return String(process.env['OWNER_CEILING_SHADOW_ENABLED'] ?? '').toLowerCase() === 'true';
}

export interface AttenuatedCeiling {
  ceiling: number;
  /** True when the owner's limit — not the agent's tier — is what binds. */
  narrowed: boolean;
  boundBy: 'agent_tier' | 'owner_limit';
}

/**
 * The attenuation algebra, in one line and one direction.
 *
 * An owner may only ever NARROW what their agent can do
 * (`trinity-ecosystem/lib/trustshell/identity/capability.ts`: "a delegation may
 * only ever NARROW authority"). So:
 *   - no owner limit               → the agent's tier ceiling, unchanged.
 *   - an owner limit above the tier → the tier still binds. An owner cannot
 *                                     promote their agent by writing a big number.
 *   - an owner limit below the tier → the owner's limit binds.
 *   - a malformed or negative limit → 0. Fails CLOSED: a limit we cannot read is
 *                                     not a licence to use the wider one.
 * Pure.
 */
export function attenuateCeiling(agentCeiling: number, ownerCap: number | null | undefined): AttenuatedCeiling {
  const agent = Number.isFinite(agentCeiling) ? Math.max(0, agentCeiling) : 0;
  if (ownerCap === null || ownerCap === undefined) {
    return { ceiling: agent, narrowed: false, boundBy: 'agent_tier' };
  }
  const owner = Number.isFinite(ownerCap) ? Number(ownerCap) : 0;
  const clamped = Math.max(0, owner);
  if (clamped >= agent) return { ceiling: agent, narrowed: false, boundBy: 'agent_tier' };
  return { ceiling: clamped, narrowed: true, boundBy: 'owner_limit' };
}

export type ShadowVerdict =
  /** Owner resolved and the ceiling is unchanged — switching would change nothing here. */
  | 'agree'
  /** Owner resolved and their limit binds tighter — switching would TIGHTEN this decision. */
  | 'shadow_stricter'
  /** Every source was consulted and none names an owner. Not a disagreement — a coverage gap. */
  | 'no_owner'
  /** A source could not be consulted. NOT the same as no_owner, and never counted with it. */
  | 'owner_unknown'
  /** The shadow path itself failed. Recorded, never propagated. */
  | 'error'
  /** The flag is off; nothing was computed. Present so an empty dataset is legible. */
  | 'disabled';

export interface CeilingObservation {
  verdict: ShadowVerdict;
  agent: string;
  amount: number;
  /** What the live gate decided, and what the caller acts on. */
  realAuthorized: boolean;
  realPerTxLimit: number;
  /** What it would have decided with the owner's limit applied. Recorded only. */
  shadowAuthorized: boolean;
  shadowPerTxLimit: number;
  ownerStatus: OwnerResolution['status'] | null;
  ownerAssurance: string | null;
  ownerCapUsdcPerTx: number | null;
  /**
   * Would a policy of "no authorised spend without an established owner" deny
   * this? This is the cost of enforcement, and it is driven by coverage, not by
   * ceilings — which is why it is a separate field and not folded into `verdict`.
   */
  wouldDenyIfOwnerRequired: boolean;
  detail: string;
  observedAt: string;
}

export interface CompareInput {
  agent: string;
  amount: number;
  realAuthorized: boolean;
  realPerTxLimit: number;
  resolution: OwnerResolution;
  now?: Date;
}

/**
 * Compare the real ceiling with the owner-attenuated one. Pure — the resolution
 * is injected, so the whole policy is testable without a database.
 *
 * `shadowAuthorized` can only ever be a subset of `realAuthorized`: a transaction
 * the live gate refused is never granted here.
 */
export function compareCeilings(input: CompareInput): CeilingObservation {
  const observedAt = (input.now ?? new Date()).toISOString();
  const cap = ownerPerTxCap(input.resolution);
  const attenuated = attenuateCeiling(input.realPerTxLimit, cap);
  const shadowAuthorized = input.realAuthorized && input.amount <= attenuated.ceiling;

  const base = {
    agent: input.agent,
    amount: input.amount,
    realAuthorized: input.realAuthorized,
    realPerTxLimit: input.realPerTxLimit,
    shadowAuthorized,
    shadowPerTxLimit: attenuated.ceiling,
    ownerStatus: input.resolution.status,
    ownerAssurance: input.resolution.owner?.assurance ?? null,
    ownerCapUsdcPerTx: cap,
    observedAt,
  };

  if (input.resolution.status === 'unknown') {
    return {
      ...base,
      verdict: 'owner_unknown',
      wouldDenyIfOwnerRequired: input.realAuthorized,
      detail:
        `owner could not be determined (${input.resolution.reason ?? 'no reason given'}). ` +
        'This is NOT evidence the agent has no owner, and must never be counted with no_owner.',
    };
  }

  if (input.resolution.status === 'none') {
    return {
      ...base,
      verdict: 'no_owner',
      wouldDenyIfOwnerRequired: input.realAuthorized,
      detail:
        'every source was consulted and none names an owner. Expected while the signed ' +
        'ownership tables are empty — this records coverage, not agreement.',
    };
  }

  return {
    ...base,
    verdict: attenuated.narrowed ? 'shadow_stricter' : 'agree',
    wouldDenyIfOwnerRequired: false,
    detail: attenuated.narrowed
      ? `owner limit ${String(cap)} binds below the tier ceiling ${input.realPerTxLimit} — switching would TIGHTEN this decision`
      : 'owner established and their limits do not bind here; switching changes nothing',
  };
}

/**
 * Resolve, compare, record. NEVER THROWS, never changes the caller's decision.
 *
 * Returns the observation so a test can assert on it; the x402 path ignores it.
 */
export async function observeOwnerCeiling(input: {
  agent: string;
  amount: number;
  decision: Pick<AuthorityDecision, 'authorized' | 'per_tx_limit'>;
  now?: Date;
}): Promise<CeilingObservation> {
  const observedAt = (input.now ?? new Date()).toISOString();
  if (!ownerCeilingShadowEnabled()) {
    return {
      verdict: 'disabled',
      agent: input.agent,
      amount: input.amount,
      realAuthorized: input.decision.authorized,
      realPerTxLimit: input.decision.per_tx_limit,
      shadowAuthorized: input.decision.authorized,
      shadowPerTxLimit: input.decision.per_tx_limit,
      ownerStatus: null,
      ownerAssurance: null,
      ownerCapUsdcPerTx: null,
      wouldDenyIfOwnerRequired: false,
      detail: 'OWNER_CEILING_SHADOW_ENABLED is not set — nothing read, nothing recorded, nothing observed.',
      observedAt,
    };
  }

  let observation: CeilingObservation;
  try {
    const resolution = await resolveOwner({ agentName: input.agent });
    observation = compareCeilings({
      agent: input.agent,
      amount: input.amount,
      realAuthorized: input.decision.authorized,
      realPerTxLimit: input.decision.per_tx_limit,
      resolution,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (err) {
    observation = {
      verdict: 'error',
      agent: input.agent,
      amount: input.amount,
      realAuthorized: input.decision.authorized,
      realPerTxLimit: input.decision.per_tx_limit,
      shadowAuthorized: input.decision.authorized,
      shadowPerTxLimit: input.decision.per_tx_limit,
      ownerStatus: null,
      ownerAssurance: null,
      ownerCapUsdcPerTx: null,
      wouldDenyIfOwnerRequired: false,
      detail: `shadow comparison failed (gate decision unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
      observedAt,
    };
  }

  await record(observation);
  return observation;
}

/**
 * `trinity_agent_logs.agent` is NOT NULL and the discriminator column is `action`
 * — six audit actions wrote zero rows for the table's whole lifetime by getting
 * that wrong (see engine/agent-log-row.ts). Using the shared builder is what
 * stops this shadow from being the seventh: a shadow log that is silently empty
 * looks exactly like a shadow that found nothing.
 */
async function record(o: CeilingObservation): Promise<void> {
  try {
    await logAgentEvent(
      buildAgentLogRow({
        agent: o.agent,
        agent_name: o.agent,
        action: 'owner_ceiling_shadow',
        content: `${o.verdict}: real=${o.realPerTxLimit} shadow=${o.shadowPerTxLimit} amount=${o.amount}`,
        metadata: { ...o, shadowMode: true, gateUnchanged: true },
      }),
      // warn, not info: agent-log SAMPLES info events, and a sampled shadow
      // produces a biased dataset that still looks like a complete one.
      'warn',
    );
  } catch (err) {
    console.error(
      `[owner-ceiling-shadow] observation NOT recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The analysis to run once observation has been on for a while. Versioned with
 * the code that produces the data, for the same reason CustodyShadow does it.
 *
 * Read `no_owner` + `owner_unknown` FIRST and keep them apart. Their sum is the
 * cost of requiring an owner; `shadow_stricter` alone is the cost of the
 * ceilings, and on 2026-08-17 that number was zero while the coverage gap was
 * most of the fleet.
 */
export const OWNER_CEILING_SHADOW_SQL = `
select
  metadata->>'verdict'                                          as verdict,
  count(*)                                                      as observations,
  count(distinct agent)                                         as agents,
  count(*) filter (where (metadata->>'wouldDenyIfOwnerRequired')::boolean) as would_deny_if_owner_required,
  min(created_at)                                               as first_seen,
  max(created_at)                                               as last_seen
from trinity_agent_logs
where action = 'owner_ceiling_shadow'
group by 1
order by observations desc;
`.trim();
