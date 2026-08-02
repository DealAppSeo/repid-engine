/**
 * byok-custody.ts — hold a user's provider API keys so they never have to paste
 * one into a request again.
 *
 * WHY THIS EXISTS. Today `user_paid_keys` is read straight from the HTTP request
 * body (routes/route.ts). BYOK "works" in the sense that routing honours it, but
 * every caller has to ship raw provider credentials on every call. For a product
 * whose entire argument is "you don't have to trust us", teaching users to paste
 * secrets into a request body is the wrong first lesson — and it is the one they
 * would copy from a demo.
 *
 * THREE RULES, all enforced here rather than documented and hoped for:
 *
 *   1. A key is stored only after a PROBE says LIVE. Presence is not evidence;
 *      HUGGINGFACE_API_TOKEN was set everywhere and dead, and took the broker
 *      down with it. Storing a dead key means the user's first real call fails
 *      and teaches them the product is broken.
 *   2. A stored key is NEVER returned. Not by any endpoint, not in a log, not in
 *      an error message, not as a prefix. `listKeys` returns metadata only, and
 *      the type it returns has no field a key could hide in.
 *   3. Decryption happens only at the moment of use, inside the process, and the
 *      plaintext is never persisted or attached to a response.
 *
 * FLAG: BYOK_CUSTODY_ENABLED (default OFF). This is original work that touches
 * live state, so per CLAUDE_RULES 23 it lands finished-and-inert and is switched
 * on after Sean has seen it work.
 *
 * SECURITY CEILING — read before enabling for anyone but us. Encryption reuses
 * agent-key-crypto.ts: AES-256-GCM under a single symmetric master key held in
 * AGENT_KEY_MASTER. That is application-level custody. Anyone who can read that
 * env var and the table can decrypt every user's keys. Provider API keys are a
 * softer target than wallet private keys — they are revocable and rate-limited,
 * and cannot move funds — but this is still the interim scheme, and the KMS /
 * Vault upgrade described in agent-key-crypto.ts applies here too.
 */
import { db } from '../db';
import { encryptPrivateKey, decryptPrivateKey, KEY_VERSION } from './agent-key-crypto';
import { probeProviderKey, probeFor, supportedProviders, independentFamilies } from './provider-key-probe';

export const BYOK_CUSTODY_ENABLED = process.env.BYOK_CUSTODY_ENABLED === 'true';

export type OwnerKind = 'human_sbt' | 'builder' | 'agent';

export interface KeyOwner {
  kind: OwnerKind;
  id: string;
}

/**
 * What a caller is allowed to see about a stored key.
 *
 * Deliberately has no field that could carry key material — not a masked value,
 * not the last four characters. A "safe" prefix is still a leak that narrows a
 * brute force, and once a field exists someone eventually fills it.
 */
export interface StoredKeyInfo {
  provider: string;
  label: string;
  family: string;
  verify_status: string;
  verify_detail: string | null;
  verified_at: string | null;
  created_at: string;
  rotated_at: string | null;
}

export interface StoreResult {
  ok: boolean;
  reason?: 'disabled' | 'unknown_provider' | 'probe_failed' | 'probe_inconclusive' | 'write_failed';
  detail: string;
  stored?: StoredKeyInfo;
}

const infoFrom = (row: Record<string, unknown>): StoredKeyInfo => ({
  provider: String(row.provider),
  label: String(row.label),
  family: probeFor(String(row.provider))?.family ?? 'unknown',
  verify_status: String(row.verify_status),
  verify_detail: (row.verify_detail as string) ?? null,
  verified_at: (row.verified_at as string) ?? null,
  created_at: String(row.created_at),
  rotated_at: (row.rotated_at as string) ?? null,
});

/**
 * Verify, then store. Never the other way round.
 *
 * An INCONCLUSIVE probe is refused rather than stored optimistically: we would
 * be recording "this works" on evidence that does not say so, and the user finds
 * out at the worst moment. It is also refused rather than recorded as DEAD —
 * telling someone to rotate a working key on a flaky network is its own harm.
 */
export async function storeProviderKey(
  owner: KeyOwner,
  provider: string,
  apiKey: string,
  label = 'default',
): Promise<StoreResult> {
  if (!BYOK_CUSTODY_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'BYOK custody is not enabled on this deployment.' };
  }
  const p = probeFor(provider);
  if (!p) {
    return {
      ok: false,
      reason: 'unknown_provider',
      detail: `Unknown provider '${provider}'. Supported: ${supportedProviders().join(', ')}.`,
    };
  }

  const probe = await probeProviderKey(p.provider, apiKey);
  if (probe.status === 'DEAD') {
    return {
      ok: false,
      reason: 'probe_failed',
      detail: `${p.provider} rejected this key (${probe.detail}). Not stored — a stored dead key fails on your first real call.`,
    };
  }
  if (probe.status === 'INCONCLUSIVE') {
    return {
      ok: false,
      reason: 'probe_inconclusive',
      detail: `Could not confirm this key with ${p.provider} (${probe.detail}). Not stored, and NOT treated as dead — try again rather than rotating it.`,
    };
  }

  const encrypted = encryptPrivateKey(apiKey);
  const now = new Date().toISOString();

  // Rotation rather than duplication: retire any live row for this
  // owner/provider/label, because the partial unique index allows exactly one.
  await db
    .from('user_provider_keys')
    .update({ revoked_at: now, revoke_reason: 'rotated' })
    .eq('owner_kind', owner.kind)
    .eq('owner_id', owner.id)
    .eq('provider', p.provider)
    .eq('label', label)
    .is('revoked_at', null);

  const { data, error } = await db
    .from('user_provider_keys')
    .insert({
      owner_kind: owner.kind,
      owner_id: owner.id,
      provider: p.provider,
      label,
      encrypted_key: encrypted,
      key_version: KEY_VERSION,
      verify_status: 'LIVE',
      verify_detail: probe.detail,
      verified_at: now,
    })
    .select('provider, label, verify_status, verify_detail, verified_at, created_at, rotated_at')
    .maybeSingle();

  // The error is CHECKED. An unchecked write is how a settlement once reported
  // SETTLED while the row never landed.
  if (error || !data) {
    return { ok: false, reason: 'write_failed', detail: error?.message ?? 'insert returned no row' };
  }
  return { ok: true, detail: `Verified with ${p.provider} and stored.`, stored: infoFrom(data) };
}

/** Metadata only. There is no code path that returns a stored key to a caller. */
export async function listKeys(owner: KeyOwner): Promise<StoredKeyInfo[]> {
  const { data } = await db
    .from('user_provider_keys')
    .select('provider, label, verify_status, verify_detail, verified_at, created_at, rotated_at')
    .eq('owner_kind', owner.kind)
    .eq('owner_id', owner.id)
    .is('revoked_at', null)
    .order('created_at');
  return (data ?? []).map(infoFrom);
}

export async function revokeKey(owner: KeyOwner, provider: string, label = 'default', reason = 'user_revoked') {
  const { error } = await db
    .from('user_provider_keys')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
    .eq('owner_kind', owner.kind)
    .eq('owner_id', owner.id)
    .eq('provider', provider)
    .eq('label', label)
    .is('revoked_at', null);
  return { ok: !error, detail: error?.message ?? 'revoked' };
}

/**
 * Decrypt for a single call. INTERNAL — never expose this through a route.
 *
 * Returns the shape routes/route.ts already understands ({ provider: key }), so
 * custody plugs into the existing router without changing how routing works.
 */
export async function resolveKeysForRouting(owner: KeyOwner): Promise<Record<string, string>> {
  if (!BYOK_CUSTODY_ENABLED) return {};
  const { data } = await db
    .from('user_provider_keys')
    .select('provider, encrypted_key')
    .eq('owner_kind', owner.kind)
    .eq('owner_id', owner.id)
    .eq('verify_status', 'LIVE')
    .is('revoked_at', null);

  const out: Record<string, string> = {};
  for (const row of data ?? []) {
    try {
      out[String(row.provider)] = decryptPrivateKey(row.encrypted_key as never);
    } catch {
      // A blob encrypted under a retired master key must not take the whole
      // request down — the user simply routes without that provider. Logged
      // WITHOUT the provider's key material.
      console.warn(`[byok] could not decrypt stored key for provider=${row.provider} (master key rotated?)`);
    }
  }
  return out;
}

/**
 * The number that decides whether HAL can even run at its measured width for
 * this user: how many INDEPENDENT families their own keys buy.
 *
 * A user with five keys across two families has a 2-family fleet, and any
 * accuracy claim measured at 3 is unreadable for them. Surfacing this is what
 * lets the product say "add one more provider and your agent gets a real
 * second opinion" instead of silently degrading.
 */
export async function ownerFamilyWidth(owner: KeyOwner): Promise<{ families: string[]; width: number }> {
  const keys = await listKeys(owner);
  const families = independentFamilies(keys.filter((k) => k.verify_status === 'LIVE').map((k) => k.provider));
  return { families, width: families.length };
}
