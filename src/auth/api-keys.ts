import crypto from 'crypto';
import { db } from '../db';

export async function issueAgentApiKey(agentId: string, name: string = 'default', scopes: string[] = []): Promise<{key: string, key_prefix: string}> {
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

export async function revokeAgentApiKey(keyId: string): Promise<void> {
  await db.from('agent_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId);
}
