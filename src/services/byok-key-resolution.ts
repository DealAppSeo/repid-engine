/**
 * byok-key-resolution.ts — turn an AUTHENTICATED agent into the provider keys its
 * owner custodied, for the routing path. The missing half of BYOK custody.
 *
 * WHY THIS EXISTS. `byok-custody.ts` can store a user's provider keys and
 * `resolveKeysForRouting(owner)` can decrypt them, but NOTHING called it — stored
 * keys were never used. This module is the one caller, and it is deliberately the
 * whole trust boundary: given the agent a request was authenticated as, it answers
 * "whose stored keys, if anyone's, may this call use" and returns the decrypted map
 * (or `{}`). `routes/route.ts` merges that under the request body.
 *
 * THE ONE RULE THAT MATTERS. A stored key is its OWNER's secret. It may be used
 * ONLY for a call made by an agent that owner has PROVEN they own. "Proven" here
 * is not a figure of speech: it is a wallet signature recorded in
 * `human_agent_bindings` (assurance `proven_human` / `proven_wallet`). Every weaker
 * signal — the administrative `repid_agents.builder_id` FK (which
 * `human-agent-binding.ts` and `agent-owner-resolver.ts` both state is NOT evidence
 * of ownership), an unverified delegation, a declared custodian tier — is REFUSED.
 * Using owner A's key on the strength of an unsigned FK would hand A's paid
 * credential to whoever controls an agent merely created under A's account, which
 * is exactly the leak the custody design exists to prevent. If identity is
 * uncertain, we use no stored keys. Correctness here beats shipping a key.
 *
 * WHY THE OWNER KEYS LINE UP. Keys are stored (routes/v1/byok.ts → `ownerFor`)
 * under the proven account: `{kind:'builder', id: builders.id}` or
 * `{kind:'human_sbt', id: human_sbt_registry.token_id}`. A signed binding records
 * that SAME `{owner_kind, owner_id}` for the agent. `agent-owner-resolver.ts`
 * surfaces the signed binding as `proven_wallet` (ownerKeyKind `builder_id`,
 * ownerKey = builders.id) or `proven_human` (ownerKeyKind `human_sbt_token`,
 * ownerKey = token_id). So the proven claim's key is exactly the key the custody
 * row was written under — and a wallet- or tier-shaped claim (which the custody
 * table is never keyed by) maps to no custody owner and is refused, fail-closed.
 *
 * INERT until enabled. Short-circuits to `{}` when BYOK_CUSTODY_ENABLED is off,
 * BEFORE any database read — so a disabled deployment behaves EXACTLY like today's
 * body-only routing and does not even look up an owner.
 */
import { resolveOwner, type OwnerClaim } from './agent-owner-resolver';
import { BYOK_CUSTODY_ENABLED, resolveKeysForRouting, type KeyOwner } from './byok-custody';

/** Only genuine, non-empty string values from a possibly-untrusted object. */
function asKeyMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out;
}

/**
 * Merge stored keys under request-body keys.
 *
 * PRECEDENCE (the chosen default, and easily flipped): the request body WINS;
 * stored keys only FILL providers the body did not supply. A caller passing a key
 * explicitly for this one request overrides whatever is in custody — the obvious
 * least-surprise behaviour. To prefer custody instead, swap the two spreads below.
 *
 * A blank body value is treated as "not supplied", so a stored key still fills it.
 * Pure: no I/O, no env, no flag.
 */
export function mergeEffectiveKeys(stored: unknown, body: unknown): Record<string, string> {
  return { ...asKeyMap(stored), ...asKeyMap(body) };
}

/**
 * Map a PROVEN owner claim to the custody owner its keys are stored under.
 *
 * Returns null for anything that is not a concrete custody namespace. The custody
 * table is keyed only by `builder` (builders.id) and `human_sbt` (token_id); a
 * `wallet` or `opaque` claim — or a null key — has no row it could match, so we
 * refuse rather than guess an owner.
 */
export function keyOwnerFromClaim(owner: OwnerClaim): KeyOwner | null {
  if (!owner.ownerKey) return null;
  if (owner.ownerKeyKind === 'human_sbt_token') return { kind: 'human_sbt', id: owner.ownerKey };
  if (owner.ownerKeyKind === 'builder_id') return { kind: 'builder', id: owner.ownerKey };
  return null;
}

/**
 * The decrypted provider keys that THIS authenticated agent's PROVEN owner has in
 * custody — or `{}` when custody is off, the agent is unknown, ownership is not
 * proven by signature, or the owner maps to no custody namespace.
 *
 * `agentId` MUST be the id the request was authenticated as (routes/route.ts
 * enforces that an agent-scoped API key matches this exact agent before calling
 * here). Never pass an unauthenticated or caller-asserted agent id: the whole
 * guarantee is that a stored key only travels for a call its owner authorised.
 */
export async function resolveOwnerStoredKeys(
  agentId: string | null | undefined,
): Promise<Record<string, string>> {
  // Inert-safe and read-free when disabled. `resolveKeysForRouting` enforces the
  // same flag; this early-out additionally avoids an owner lookup on every routed
  // call while the feature is off. Both read the one module-level flag, so they
  // cannot disagree within a process.
  if (!BYOK_CUSTODY_ENABLED) return {};
  if (!agentId || typeof agentId !== 'string') return {};

  // resolveOwner never throws (every failure becomes an `unknown` resolution), but
  // treat any surprise as "no owner" rather than failing the whole request open.
  let resolution;
  try {
    resolution = await resolveOwner({ id: agentId });
  } catch {
    return {};
  }

  // THE GATE. Only a signed ownership binding is strong enough to spend an owner's
  // key. 'resolved' with proven_* assurance ⟺ a live human_agent_bindings row;
  // 'unknown'/'none', or any weaker winning claim (attested_unverified / declared /
  // administrative), yields no stored keys.
  if (resolution.status !== 'resolved' || !resolution.owner) return {};
  const assurance = resolution.owner.assurance;
  if (assurance !== 'proven_human' && assurance !== 'proven_wallet') return {};

  const keyOwner = keyOwnerFromClaim(resolution.owner);
  if (!keyOwner) return {};

  return resolveKeysForRouting(keyOwner);
}
