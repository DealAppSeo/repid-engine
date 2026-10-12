/**
 * durable-caps.ts — the effective per-(agent, domain) spend cap, computed in code, fail closed.
 *
 * Lane 1. The effective cap an agent may spend in a domain is the MINIMUM of four independent
 * limits, so that no single input can ever WIDEN it:
 *
 *   1. owner_ceiling   — the owner's SIGNED ceiling for this (agent, domain). Durable: a row in
 *                        `durable_spend_caps`, carrying a signature. A ceiling with no signature is
 *                        not a grant. (Signature PRESENCE is checked here; cryptographic
 *                        verification is NOT CHECKED and is a separate concern — see below.)
 *   2. stake           — the agent's posted stake, in USDC. Read live.
 *   3. repid_in_domain — the RepID tier ceiling IN THAT DOMAIN. Domain-scoped on purpose: a coding
 *                        score must never buy a trade. The domain RepID is looked up by (agent,
 *                        domain); if the agent has no reputation in the domain, there is no cap and
 *                        the decision REFUSES. Mapped to a USDC ceiling by a tier table the caller
 *                        injects (so this module stays independent of x402-gate — see the wire-in).
 *   4. ethics_floor    — the ETHICS_FLOOR_USDC constant below. It is not read from configuration and
 *                        not stored in a row, so nothing at runtime can raise it or switch it off.
 *                        Because the cap is a MIN, this value is an absolute ceiling nothing exceeds.
 *
 * RepID may only TIGHTEN the cap. It is one term of a MIN, so it can lower the effective cap but can
 * never raise it above the owner ceiling or the stake. This is a property of the arithmetic, not a
 * rule in prose, and the tests break the arithmetic to prove it.
 *
 * THREE OUTCOMES, NEVER TWO. Every input resolves to a number, or it is UNREADABLE. A missing caps
 * row, a missing table, a malformed value, or any read that throws is UNREADABLE, and ANY unreadable
 * input REFUSES (effective cap 0). There is no permissive fallback: "we could not read it" never
 * collapses into "allow". A readable zero (owner granted 0, stake 0, probationary domain) is a
 * resolved cap of 0 — distinct from a refusal, and still denies every positive spend.
 *
 * This module imports nothing from `x402-gate.ts`. The dependency runs one way: x402-gate imports
 * this. The domain-RepID → USDC mapping is injected by the caller (`ResolveOpts.tierLimitUsdc`), so
 * there is no import cycle and this module can be unit-tested with no database and no x402 types.
 */

import { db } from '../db';

/**
 * THE ETHICS FLOOR. A hard, un-overridable ceiling on any single automated spend decision, in USDC.
 *
 * It lives here, in code, on purpose. It is deliberately NOT read from the environment and NOT stored
 * in a table: a limit that nobody can switch off must not be a value anybody can edit at runtime. If
 * it were an env var, unsetting it would disable it; if it were a DB row, a write would raise it. It
 * is a `const`, so the only way to change it is to change the source and ship it through review.
 *
 * It sits ABOVE the normal tier/owner/stake ceilings (x402 VETERAN per-tx is 5000), so in ordinary
 * operation one of the other three binds first and this value never shows. Its job is the backstop:
 * if a mis-configured owner ceiling or an over-counted stake would otherwise authorize an extreme
 * amount, the MIN still clamps it here. Changing this number is an ethics decision, not a tuning
 * knob — do not raise it to make a payment go through.
 */
export const ETHICS_FLOOR_USDC = 10_000;

/** Default OFF. Read per-call (not at import) so a deployment can arm it without a restart, and so a
 *  test can flip it. While off, the wire-in performs NO reads: the feature is inert, not merely quiet. */
export function durableCapsEnabled(): boolean {
  return String(process.env['DURABLE_CAPS_ENABLED'] ?? '').toLowerCase() === 'true';
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Readable<T>: a value we actually read, or a named reason we could not. Mirrors the house rule
// (effective-authority.ts, human-spend-shadow.ts): NOT_CHECKED is never the same as a number.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export type Unreadable = { readable: false; reason: string };
export type Usdc = { readable: true; usdc: number };
export type CapInput = Usdc | Unreadable;

export type DomainRepid = { readable: true; repid: number } | Unreadable;

/** Which of the four MIN terms bound the result (or forced the refusal). A denial you cannot name is
 *  not actionable (the same reason effective-authority.ts carries `bindingTerm`). */
export type CapTerm = 'owner_ceiling' | 'stake' | 'repid_in_domain' | 'ethics_floor';

export interface EffectiveCap {
  /** True when all four inputs resolved. False is a refusal, never a quiet allow. */
  resolved: boolean;
  /** USDC the agent may spend for this (agent, domain). 0 on any refusal, and may legitimately be 0
   *  when resolved (e.g. the owner granted 0). */
  effectiveCapUsdc: number;
  /** On a resolved cap: the smallest term. On a refusal: the term that was unreadable. */
  bindingTerm: CapTerm | null;
  /** Null when resolved; a reason string when refused. */
  refusalReason: string | null;
  inputs: {
    owner_ceiling: CapInput;
    stake: CapInput;
    repid_in_domain: CapInput;
    ethics_floor_usdc: number;
  };
  agentId: string;
  domain: string;
  detail: string;
}

/**
 * Canonical 5-tier ladder, score → tier name. Mirrors `computeTier` in engine/repid-update.ts and
 * the thresholds published in CLAUDE.md (PROBATIONARY/EARNING/ESTABLISHED/AUTONOMOUS/VETERAN). Kept
 * LOCAL rather than imported from the engine because importing repid-update pulls scoring-params,
 * which THROWS at import in production when its tuned env vars are unset — a cap resolver must never
 * be able to fail to load. These thresholds are public (not tuned scoring constants), so a local
 * copy is honest. If the ladder changes, change it there and here (LESSONS rule 10).
 */
export function canonicalTierForRepid(repid: number): string {
  if (!Number.isFinite(repid)) return 'PROBATIONARY';
  if (repid >= 8000) return 'VETERAN';
  if (repid >= 5000) return 'AUTONOMOUS';
  if (repid >= 1000) return 'ESTABLISHED';
  if (repid >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

/** A finite, non-negative USDC number, or UNREADABLE. A value we cannot trust is not a licence to use
 *  a wider one — same discipline as attenuate-ceiling.ts (malformed → 0/refuse, never the big number). */
function asUsdc(n: number | null | undefined, malformedReason: string): CapInput {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return { readable: false, reason: malformedReason };
  }
  return { readable: true, usdc: n };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// The pure heart. No IO. All four inputs already resolved. This is the min-of-four.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ComputeInputs {
  owner: CapInput;
  stake: CapInput;
  repidInDomain: CapInput;
  agentId: string;
  domain: string;
}

export function computeEffectiveCap(input: ComputeInputs): EffectiveCap {
  const ethicsFloor = ETHICS_FLOOR_USDC; // always a valid, finite, un-overridable constant
  const base = {
    agentId: input.agentId,
    domain: input.domain,
    inputs: {
      owner_ceiling: input.owner,
      stake: input.stake,
      repid_in_domain: input.repidInDomain,
      ethics_floor_usdc: ethicsFloor,
    },
  };

  // Any unreadable input is a refusal. Checked in a fixed order so the reported binding term is
  // deterministic. owner → stake → repid_in_domain. (ethics_floor is a constant, never unreadable.)
  const terms: [CapTerm, CapInput][] = [
    ['owner_ceiling', input.owner],
    ['stake', input.stake],
    ['repid_in_domain', input.repidInDomain],
  ];
  for (const [term, value] of terms) {
    if (!value.readable) {
      return {
        ...base,
        resolved: false,
        effectiveCapUsdc: 0,
        bindingTerm: term,
        refusalReason: `${term}_unreadable:${value.reason}`,
        detail:
          `REFUSE: ${term} is unreadable (${value.reason}). An unreadable input fails closed — ` +
          `effective cap 0. NOT CHECKED is not a pass.`,
      };
    }
    // Defense in depth: even a value marked readable must be a finite, non-negative number. A
    // malformed number is treated as unreadable, never clamped-to-wide. This holds no matter how the
    // CapInput was constructed, so computeEffectiveCap cannot be handed a negative that lowers the min
    // below 0 or a NaN that poisons it.
    if (!Number.isFinite(value.usdc) || value.usdc < 0) {
      return {
        ...base,
        resolved: false,
        effectiveCapUsdc: 0,
        bindingTerm: term,
        refusalReason: `${term}_malformed`,
        detail: `REFUSE: ${term} is a malformed number (${value.usdc}). Fails closed — effective cap 0.`,
      };
    }
  }

  // All readable. The effective cap is the minimum of the four. Precedence on a tie: owner, stake,
  // repid_in_domain, then ethics_floor — so ethics_floor is reported as binding only when it is
  // STRICTLY the smallest, which is what the "ethics floor cannot be exceeded" test asserts.
  const candidates: [CapTerm, number][] = [
    ['owner_ceiling', (input.owner as Usdc).usdc],
    ['stake', (input.stake as Usdc).usdc],
    ['repid_in_domain', (input.repidInDomain as Usdc).usdc],
    ['ethics_floor', ethicsFloor],
  ];
  let bindingTerm: CapTerm = candidates[0]![0];
  let effective = candidates[0]![1];
  for (const [term, v] of candidates) {
    if (v < effective) {
      effective = v;
      bindingTerm = term;
    }
  }

  return {
    ...base,
    resolved: true,
    effectiveCapUsdc: effective,
    bindingTerm,
    refusalReason: null,
    detail:
      `min(owner ${(input.owner as Usdc).usdc}, stake ${(input.stake as Usdc).usdc}, ` +
      `repid_in_domain ${(input.repidInDomain as Usdc).usdc}, ethics_floor ${ethicsFloor}) ` +
      `= ${effective} (bound by ${bindingTerm}).`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Data source. Injected so the resolver is testable with no database. Each method fails closed:
// an absent row/table, a malformed value, or a thrown read all become UNREADABLE with a named reason.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface CapDataSource {
  /** The owner's signed ceiling for (agent, domain). Absent row / absent table → unreadable. */
  ownerCeiling(agentId: string, domain: string): Promise<CapInput>;
  /** The agent's posted stake, USDC. A thrown read → unreadable; a genuine 0 → readable 0. */
  stake(agentId: string): Promise<CapInput>;
  /** The agent's RepID IN THIS DOMAIN. No domain activity → unreadable ('no_domain_repid'). */
  domainRepid(agentId: string, domain: string): Promise<DomainRepid>;
}

function isMissingRelation(err: unknown): boolean {
  const msg = (err && typeof err === 'object' && 'message' in err ? String((err as any).message) : String(err)).toLowerCase();
  const code = err && typeof err === 'object' && 'code' in err ? String((err as any).code) : '';
  // Postgres 42P01 "relation does not exist"; PostgREST PGRST205 "could not find the table".
  return code === '42P01' || code === 'PGRST205' || msg.includes('does not exist') || msg.includes('could not find the table');
}

/**
 * The real, Supabase-backed source. Owner ceiling comes from `durable_spend_caps`; stake is read from
 * the agent's active stake rows; domain RepID is the agent's most recent `repid_after` among score
 * events tagged with this `task_domain`.
 *
 * NOTE (honest scope, not a claim of completeness):
 *  - Signature: only PRESENCE of `owner_signature` is checked. Cryptographic verification is NOT
 *    CHECKED here; wire a verifier before arming enforcement in production.
 *  - Domain RepID approximation: `repid_after` is the agent's GLOBAL score at the time of a domain
 *    event, not a domain-isolated ledger (none exists in this schema). The DOMAIN SCOPING is exact —
 *    only events with `task_domain = domain` are considered, so a coding-only agent has no trade-
 *    domain RepID and is refused for trade spend — but the magnitude is a ledger-at-domain-event
 *    approximation. Flagged so nobody reads it as a true per-domain ledger value.
 *  - Stake key convention and the `repid_score_events.agent_id` key (slug vs uuid) are NOT fully
 *    normalized across the codebase; the wire-in passes x402's own already-computed stake instead of
 *    calling `stake()` here, and the domain filter is the load-bearing correctness property.
 */
export function supabaseCapDataSource(client: typeof db = db): CapDataSource {
  return {
    async ownerCeiling(agentId, domain): Promise<CapInput> {
      try {
        const { data, error } = await client
          .from('durable_spend_caps')
          .select('owner_ceiling_usdc, owner_signature, active')
          .eq('agent_id', agentId)
          .eq('domain', domain)
          .eq('active', true)
          .maybeSingle();
        if (error) {
          if (isMissingRelation(error)) return { readable: false, reason: 'caps_table_absent' };
          return { readable: false, reason: `caps_read_error:${error.code ?? 'unknown'}` };
        }
        if (!data) return { readable: false, reason: 'no_cap_row' };
        const sig = (data as any).owner_signature;
        if (typeof sig !== 'string' || sig.trim() === '') {
          return { readable: false, reason: 'cap_row_unsigned' };
        }
        return asUsdc(Number((data as any).owner_ceiling_usdc), 'owner_ceiling_malformed');
      } catch (err) {
        if (isMissingRelation(err)) return { readable: false, reason: 'caps_table_absent' };
        return { readable: false, reason: 'owner_ceiling_read_threw' };
      }
    },

    async stake(agentId): Promise<CapInput> {
      try {
        const shortId = agentId.replace(/^trinity-/i, '').toUpperCase();
        const { data, error } = await client
          .from('agent_stakes')
          .select('stake_amount')
          .eq('staker_agent', shortId)
          .eq('status', 'active');
        if (error) return { readable: false, reason: `stake_read_error:${error.code ?? 'unknown'}` };
        const rows = (data ?? []) as any[];
        // stake_amount is micro-USDC. A genuine empty set is a readable 0, not an unreadable.
        const usd = rows.reduce((s, r) => s + Number(r.stake_amount ?? 0) / 1_000_000, 0);
        return asUsdc(usd, 'stake_malformed');
      } catch {
        return { readable: false, reason: 'stake_read_threw' };
      }
    },

    async domainRepid(agentId, domain): Promise<DomainRepid> {
      try {
        const { data, error } = await client
          .from('repid_score_events')
          .select('repid_after, created_at')
          .eq('agent_id', agentId)
          .eq('task_domain', domain)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) {
          if (isMissingRelation(error)) return { readable: false, reason: 'score_events_table_absent' };
          return { readable: false, reason: `domain_repid_read_error:${error.code ?? 'unknown'}` };
        }
        if (!data) return { readable: false, reason: 'no_domain_repid' };
        const repid = Number((data as any).repid_after);
        if (!Number.isFinite(repid)) return { readable: false, reason: 'domain_repid_malformed' };
        return { readable: true, repid };
      } catch {
        return { readable: false, reason: 'domain_repid_read_threw' };
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// The resolver. Loads the four inputs via the source, maps domain RepID → USDC via an injected tier
// table (so no x402 import), then calls the pure core.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolveParams {
  agentId: string;
  domain: string;
}

export interface ResolveOpts {
  /** Maps a domain RepID score to the USDC tier ceiling. Injected by the caller (the x402 wire-in
   *  passes `repid => limitForTier(canonicalTierForRepid(repid)).per_tx`) so this module never
   *  imports x402-gate. */
  tierLimitUsdc: (repidInDomain: number) => number;
  /** Pre-resolved stake, USDC. When provided, `source.stake` is NOT called — the x402 wire-in passes
   *  the same stake figure its own gate already computed. A non-finite/negative value is treated as
   *  unreadable (fail closed), NOT as zero. Omit to read stake from the source. */
  stakeUsdc?: number | null;
}

export async function resolveEffectiveCap(
  params: ResolveParams,
  source: CapDataSource,
  opts: ResolveOpts,
): Promise<EffectiveCap> {
  const owner = await safe(() => source.ownerCeiling(params.agentId, params.domain), 'owner_ceiling_read_threw');

  let stake: CapInput;
  if (opts.stakeUsdc === undefined) {
    stake = await safe(() => source.stake(params.agentId), 'stake_read_threw');
  } else {
    stake = asUsdc(opts.stakeUsdc, 'stake_not_provided');
  }

  const domainRepid = await safeDomainRepid(
    () => source.domainRepid(params.agentId, params.domain),
    'domain_repid_read_threw',
  );
  let repidInDomain: CapInput;
  if (!domainRepid.readable) {
    repidInDomain = domainRepid;
  } else {
    let mapped: number;
    try {
      mapped = opts.tierLimitUsdc(domainRepid.repid);
    } catch {
      mapped = NaN;
    }
    repidInDomain = asUsdc(mapped, 'repid_in_domain_limit_malformed');
  }

  return computeEffectiveCap({
    owner,
    stake,
    repidInDomain,
    agentId: params.agentId,
    domain: params.domain,
  });
}

async function safe(fn: () => Promise<CapInput>, threwReason: string): Promise<CapInput> {
  try {
    return await fn();
  } catch {
    return { readable: false, reason: threwReason };
  }
}

async function safeDomainRepid(fn: () => Promise<DomainRepid>, threwReason: string): Promise<DomainRepid> {
  try {
    return await fn();
  } catch {
    return { readable: false, reason: threwReason };
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Applying the cap to a spend decision. CAN ONLY TIGHTEN. Structurally typed so this module does not
// import x402-gate's `AuthorityDecision`.
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface TightenableDecision {
  authorized: boolean;
  denial_reason: string | null;
}

/**
 * Narrow a spend decision by the durable cap. It never flips a denial into an authorization and never
 * raises a limit: on a refusal, or on an amount over the resolved cap, it can only set `authorized`
 * to false. If the decision was already denied, the original reason is kept (the durable reason is
 * only recorded when there was no prior reason), so an earlier, more specific denial is not masked.
 */
export function applyDurableCapToDecision(
  decision: TightenableDecision,
  amountUsdc: number,
  cap: EffectiveCap,
): TightenableDecision {
  if (!cap.resolved) {
    const reason = `durable_cap_refused:${cap.refusalReason}`;
    if (decision.authorized) {
      decision.authorized = false;
      decision.denial_reason = reason;
    } else if (!decision.denial_reason) {
      decision.denial_reason = reason;
    }
    return decision;
  }
  if (!(amountUsdc <= cap.effectiveCapUsdc)) {
    const reason = `exceeds_durable_cap:${cap.bindingTerm}`;
    if (decision.authorized) {
      decision.authorized = false;
      decision.denial_reason = reason;
    } else if (!decision.denial_reason) {
      decision.denial_reason = reason;
    }
  }
  // else: the durable cap permits this amount; leave the (already ≤-tight) live decision untouched.
  return decision;
}

/**
 * Map an x402 transaction type to a spend domain. PLACEHOLDER, and honest about it: there is no
 * transaction_type → domain table in the schema yet, so the transaction type IS used as the domain
 * key (lowercased/trimmed). When a tx type does not match any domain the agent has RepID in, the
 * resolver refuses — which is fail closed, the safe direction. Before arming enforcement, replace
 * this with a real mapping or an explicit `domain` on the spend request.
 */
export function domainForTransactionType(transactionType: string | null | undefined): string {
  return String(transactionType ?? '').trim().toLowerCase() || 'unknown';
}
