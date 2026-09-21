/**
 * Public identity fields for C9/C10. Bound entities stop rotting; the public
 * signal is last_verified_action. Unclaimed DBTs cannot display above Bronze.
 *
 * Kind may be absent (C7 DDL not applied). Absence is null + reason — never a
 * silent Bronze cap on every agent, and never a fabricated bound=false.
 */
import { isBoundKind, type AgentKind } from './kind-custody';
import { displayTier, type DisplayTier } from './entity-caps';
import { idleDaysSince } from './idle';

const KINDS: ReadonlySet<string> = new Set(['DBT', 'ABT', 'SBT', 'IBT']);

export function parseKind(raw: unknown): AgentKind | null {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toUpperCase();
  return KINDS.has(k) ? (k as AgentKind) : null;
}

export interface PublicIdentityFields {
  kind: AgentKind | null;
  bound: boolean | null;
  last_verified_action: string | null;
  idle_days: number | null;
  display_tier: DisplayTier | null;
  reasons: Record<string, string>;
}

export function publicIdentityFields(
  agent: {
    kind?: unknown;
    last_verified_action?: unknown;
    last_updated?: unknown;
    minted_at?: unknown;
    created_at?: unknown;
    current_repid?: unknown;
  },
  now: Date = new Date(),
): PublicIdentityFields {
  const kind = parseKind(agent.kind);
  const last =
    str(agent.last_verified_action) ??
    str(agent.last_updated) ??
    str(agent.minted_at) ??
    str(agent.created_at);
  const reasons: Record<string, string> = {};
  if (!kind) {
    reasons.kind = 'kind_not_on_row';
    reasons.display_tier = 'kind_not_on_row — Bronze ceiling applies only to unclaimed DBT';
    reasons.bound = 'kind_not_on_row';
  }
  const score = typeof agent.current_repid === 'number' ? agent.current_repid : 0;
  return {
    kind,
    bound: kind ? isBoundKind(kind) : null,
    last_verified_action: last,
    idle_days: idleDaysSince(last, now),
    display_tier: kind ? displayTier({ kind, currentRepid: score }) : null,
    reasons,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function decayBoundMode(raw: string | undefined | null = process.env.DECAY_BOUND_MODE): 'off' | 'shadow' | 'enforce' {
  const v = (raw ?? 'shadow').trim().toLowerCase();
  if (v === 'off' || v === 'enforce') return v;
  return 'shadow';
}

/**
 * E6: C9/C10 writes only on scratch (LOCAL_MODE) or an explicit enforce flag.
 * No prod backfill.
 */
export function identityWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env.IDENTITY_FEATURES || '').toLowerCase() === 'off') return false;
  if ((env.IDENTITY_FEATURES || '').toLowerCase() === 'enforce') return true;
  return (env.LOCAL_MODE || '').toLowerCase() === 'true';
}
