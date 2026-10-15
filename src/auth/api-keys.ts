import crypto from 'crypto';
import { db } from '../db';

/**
 * Is this one of the operator keys in the REPID_API_KEYS env allowlist?
 *
 * The allowlist format is `key:tier` pairs, comma separated, where `:tier` is
 * optional (`secret123:pro,corp_key:enterprise,plainkey`). Returns the resolved
 * tier on a match, or null.
 *
 * middleware/auth.ts parses the same env var inline. This is the reusable
 * definition for callers that need the check OUTSIDE the global middleware —
 * routes on the auth bypass list that do their own, stricter authorization
 * (see services/stake-authorization.ts).
 */
export function matchEnvOperatorKey(key: string): { tier: string } | null {
  if (!key) return null;
  const rawKeys = process.env.REPID_API_KEYS || '';
  for (const entry of rawKeys.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [candidate, keyTier] = entry.split(':');
    if (candidate === key) return { tier: keyTier || 'free' };
  }
  return null;
}

/**
 * [S1 2026-10-14] Scopes no HTTP path may put on an agent key. Registration is keyless and used to
 * hand every new agent `admin`, which the controller read as admin (sleep/wake/sprint, HITL decide,
 * token minting). Operator credentials are CONTROLLER_MASTER_KEY or a signed controller token
 * (middleware/controller-auth.ts); an operator script that needs a special key writes it with the
 * service role, not through here.
 */
export const RESERVED_SCOPES: readonly string[] = ['admin', 'operator'];

export async function issueAgentApiKey(agentId: string, name: string = 'default', scopes: string[] = []): Promise<{key: string, key_prefix: string}> {
  const reserved = scopes.filter((s) => RESERVED_SCOPES.includes(s));
  if (reserved.length) {
    throw new Error(`Refusing to issue reserved scope(s) on an agent key: ${reserved.join(', ')}`);
  }
  const rawKey = "ts_live_" + crypto.randomBytes(16).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.substring(0, 16);

  const { error } = await db.from('agent_api_keys').insert({
    agent_id: agentId,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    name,
    scopes
  });

  if (error) {
    throw new Error('Failed to issue API key: ' + error.message);
  }

  return { key: rawKey, key_prefix: keyPrefix };
}

export async function validateAgentApiKey(key: string): Promise<{agent_id: string, scopes: string[]} | null> {
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const { data, error } = await db.from('agent_api_keys')
    .select('agent_id, scopes')
    .eq('key_hash', keyHash)
    .is('revoked_at', null)
    .single();

  if (error || !data) {
    return null;
  }

  try {
    await db.from('agent_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('key_hash', keyHash);
  } catch (e) {
    // Ignore async update errors
  }

  return { agent_id: data.agent_id, scopes: data.scopes || [] };
}

/**
 * The legacy registration token (`constitution.api_key`, a UUID v4) as auth, for the two legacy
 * paths (key-management requireAdminAuth, agents-external). Accepts the plaintext old rows carry and
 * `api_key_sha256`, which replaces it (reports/2026-10-15 CONSTITUTION_SECRETS SQL): `constitution`
 * is readable by the anon role, so the plaintext there was a credential anyone could read.
 */
export function legacyTokenMatches(constitution: unknown, token: string): boolean {
  const c = constitution as Record<string, unknown> | null;
  if (!token || !c || typeof c !== 'object') return false;
  if (typeof c.api_key === 'string' && c.api_key === token) return true;
  return typeof c.api_key_sha256 === 'string' &&
    c.api_key_sha256 === crypto.createHash('sha256').update(token).digest('hex');
}

/** Constitution field names never serialized to a client: credentials and their hashes. */
const CONSTITUTION_SECRET_FIELD = /key|token|secret|password|private|seed|mnemonic|credential/i;

/** `constitution` minus every credential-shaped top-level field (api_key, privateId, their hashes). */
export function publicConstitution(constitution: unknown): unknown {
  if (!constitution || typeof constitution !== 'object' || Array.isArray(constitution)) return constitution ?? null;
  return Object.fromEntries(Object.entries(constitution).filter(([k]) => !CONSTITUTION_SECRET_FIELD.test(k)));
}

export async function revokeAgentApiKey(keyId: string): Promise<void> {
  await db.from('agent_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId);
}
