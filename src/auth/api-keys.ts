import crypto from 'crypto';
import { db } from '../db';

/** Width of the secretEquals compare. A longer secret is never accepted (fail closed). */
export const SECRET_COMPARE_BYTES = 1024;

/**
 * r32: THE secret compare. Every operator / admin key check routes through here, never `===`.
 * Both sides are zero-padded to SECRET_COMPARE_BYTES, so timingSafeEqual always runs over the same
 * width: no early exit on a length mismatch, and the time never depends on either length. The real
 * lengths are compared after. Not hashed: CodeQL reads a fast hash of an API key as weak password
 * hashing (the same choice as middleware/controller-auth.ts). A non-string or empty input is false,
 * never a throw (a repeated header arrives as string[]).
 */
export function secretEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length > SECRET_COMPARE_BYTES || bb.length > SECRET_COMPARE_BYTES) return false;
  const pa = Buffer.alloc(SECRET_COMPARE_BYTES);
  const pb = Buffer.alloc(SECRET_COMPARE_BYTES);
  ba.copy(pa);
  bb.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && ba.length === bb.length;
}

/**
 * Is this one of the operator keys in the REPID_API_KEYS env allowlist?
 *
 * The allowlist format is `key:tier` pairs, comma separated, where `:tier` is
 * optional (`secret123:pro,corp_key:enterprise,plainkey`). Returns the resolved
 * tier and the matched entry's index (a non-secret handle for per-key state), or null.
 *
 * The one REPID_API_KEYS check for auth: middleware/auth.ts, routes/route.ts and the
 * routes on the auth bypass list that do their own, stricter authorization
 * (see services/stake-authorization.ts) all call this.
 */
export function matchEnvOperatorKey(key: string): { tier: string; index: number } | null {
  if (!key) return null;
  const rawKeys = process.env.REPID_API_KEYS || '';
  for (const [index, entry] of rawKeys.split(',').map((s) => s.trim()).filter(Boolean).entries()) {
    const [candidate, keyTier] = entry.split(':');
    if (secretEquals(candidate, key)) return { tier: keyTier || 'free', index };
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
 * The constitution fields a client is ever shown, and only when the value is a scalar.
 * ALLOWLIST (XC1 on #1397): the first version dropped credential-looking names, which missed nested
 * keys (`rules.api_key`) and any name nobody thought of (`pin`, `passphrase`, `bearer`). These are the
 * fields the engine's routes and the repid site actually read [V 2026-10-15 grep]; `rules` is served
 * as the routes' `ruleCount`, never as its contents.
 */
const PUBLIC_CONSTITUTION_FIELDS = ['type', 'version', 'version_date', 'bio', 'personality', 'anonymous', 'eas_schema'];

export function publicConstitution(constitution: unknown): Record<string, string | number | boolean | null> | null {
  if (!constitution || typeof constitution !== 'object' || Array.isArray(constitution)) return null;
  const c = constitution as Record<string, unknown>;
  const out: Record<string, string | number | boolean | null> = {};
  for (const k of PUBLIC_CONSTITUTION_FIELDS) {
    const v = c[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as string | number | boolean | null;
  }
  return out;
}

export async function revokeAgentApiKey(keyId: string): Promise<void> {
  await db.from('agent_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId);
}
