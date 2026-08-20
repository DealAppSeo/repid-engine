/**
 * Resolves `AuthorityInputs` (effective-authority.ts) for a principal from the live database.
 *
 * Split out from `principal-grants.ts` so the mint-floor decision itself (`decideMint` there)
 * stays pure and unit-testable without a database, matching the split already established in
 * `agent-delegation.ts` (pure `decideCoverage` vs DB-touching `recordDelegation`).
 */
import { db } from '../db';
import { resolveAgentOwner } from './agent-delegation';
import type { AuthorityInputs } from './effective-authority';

export type AuthorityResolution =
  | { ok: true; inputs: AuthorityInputs }
  | { ok: false; reason: 'agent_not_found' | 'no_builder_link'; detail: string };

/**
 * `rRoute` <- repid_agents.current_repid (ledger approximation, see effective-authority.ts).
 * `builderScore` <- builders.current_repid for the resolved owning builder.
 * `stakeUsd` <- sum of REAL (is_simulated = false) stake_deposits.amount for that builder,
 * restricted to rows whose status is 'active' or 'completed' — the same real-vs-simulated
 * split `CollateralRepository.forBuilder()` uses in trinity-ecosystem (ported reasoning, not
 * ported code: that function is a Supabase-JS class method on a different client). Null (not
 * zero) when no builder link resolves, or the builder has zero real rows and we cannot tell
 * "genuinely zero" from "never checked" any other way than by looking — here we DO look, so a
 * builder with real rows summing to $0 is legitimately 0, not null.
 */
export async function resolveAuthorityInputs(agentId: string): Promise<AuthorityResolution> {
  const { data: agentRow } = await db
    .from('repid_agents')
    .select('current_repid')
    .eq('agent_name', agentId)
    .maybeSingle();

  if (!agentRow) {
    return { ok: false, reason: 'agent_not_found', detail: `no repid_agents row for agent_name '${agentId}'` };
  }
  const rRoute = Number((agentRow as any).current_repid ?? 0);

  const owner = await resolveAgentOwner(agentId);
  if (!owner) {
    return {
      ok: false,
      reason: 'no_builder_link',
      detail: `agent '${agentId}' has no resolvable builder (repid_agents.builder_id -> builders), so real collateral cannot be measured`,
    };
  }

  const { data: builderRow } = await db
    .from('builders')
    .select('current_repid')
    .eq('id', owner.builder_id)
    .maybeSingle();
  const builderScore = Number((builderRow as any)?.current_repid ?? 0);

  const { data: deposits } = await db
    .from('stake_deposits')
    .select('amount, is_simulated, status')
    .eq('builder_id', owner.builder_id);

  const rows = ((deposits as any[]) ?? []) as Array<{ amount: number; is_simulated: boolean; status: string }>;
  const real = rows.filter((r) => r.is_simulated === false && (r.status === 'active' || r.status === 'completed'));
  const stakeUsd = real.reduce((sum, r) => sum + Number(r.amount), 0);

  return { ok: true, inputs: { rRoute, stakeUsd, builderScore } };
}
