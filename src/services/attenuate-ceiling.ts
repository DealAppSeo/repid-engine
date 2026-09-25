/**
 * The owner's blast-radius cap, as a pure narrowing.
 *
 * Lives in its own file so a shadow of the human path can use the real algebra
 * without importing a module that reaches the database. `owner-ceiling-shadow.ts`
 * re-exports these names; callers that already imported them from there keep
 * working.
 *
 * An owner may only ever NARROW what their agent can do. So:
 *   - no owner limit                → the agent's tier ceiling, unchanged.
 *   - an owner limit above the tier → the tier still binds. An owner cannot
 *                                     promote their agent by writing a big number.
 *   - an owner limit below the tier → the owner's limit binds.
 *   - a malformed or negative limit → 0. A limit we cannot read is not a
 *                                     licence to use the wider one.
 */

export interface AttenuatedCeiling {
  ceiling: number;
  /** True when the owner's limit — not the agent's tier — is what binds. */
  narrowed: boolean;
  boundBy: 'agent_tier' | 'owner_limit';
}

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
