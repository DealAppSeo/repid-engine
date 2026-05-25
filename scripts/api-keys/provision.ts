/**
 * API key issuance V0 — provisioning script (Sean-runnable).
 *
 *   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. \
 *     npx tsx scripts/api-keys/provision.ts --request-id 123 --agent-id <uuid> [--scopes hal:evaluate,contracts:read]
 *
 * Flow: fetch the api_key_requests row → issue a key bound to --agent-id (reuses issueAgentApiKey,
 * which stores only the sha256 hash) → mark the request 'provisioned' (hash + timestamps) → print the
 * raw key ONCE for Sean to email. NEVER stores or logs plaintext beyond the single stdout print.
 *
 * Depends on the api_key_requests table + agent_api_keys.request_id column (migration 20260524120000).
 */
import crypto from 'crypto';
import { db } from '../../src/db';
import { issueAgentApiKey } from '../../src/auth/api-keys';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const requestId = arg('request-id');
  const agentId = arg('agent-id');
  const scopes = (arg('scopes') ?? 'hal:evaluate').split(',').map((s) => s.trim()).filter(Boolean);
  if (!requestId || !agentId) {
    console.error('Usage: provision.ts --request-id <n> --agent-id <uuid> [--scopes a,b]');
    process.exit(1);
  }

  const { data: reqRow, error: reqErr } = await db
    .from('api_key_requests')
    .select('*')
    .eq('id', Number(requestId))
    .single();
  if (reqErr || !reqRow) {
    console.error(`request ${requestId} not found:`, reqErr?.message);
    process.exit(1);
  }
  if (reqRow.status === 'provisioned') {
    console.error(`request ${requestId} already provisioned at ${reqRow.provisioned_at}. Aborting (no duplicate key).`);
    process.exit(1);
  }

  const { key, key_prefix } = await issueAgentApiKey(agentId, reqRow.email, scopes);
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');

  // Best-effort: link the freshly-issued key row to this request + tag tier (requires migration columns).
  try {
    await db.from('agent_api_keys').update({ request_id: Number(requestId), tier: 'testnet' }).eq('key_hash', keyHash);
  } catch (e) {
    console.warn('[provision] could not set request_id/tier (apply migration 20260524120000?):', (e as Error).message);
  }

  const { error: updErr } = await db
    .from('api_key_requests')
    .update({
      status: 'provisioned',
      api_key_hash: keyHash,
      provisioned_at: new Date().toISOString(),
      reviewed_at: new Date().toISOString(),
      reviewed_by: 'sean',
    })
    .eq('id', Number(requestId));
  if (updErr) console.warn('[provision] request status update failed:', updErr.message);

  console.log('\n=== API KEY PROVISIONED (copy now — shown once) ===');
  console.log(`  request_id : ${requestId}`);
  console.log(`  email      : ${reqRow.email}`);
  console.log(`  agent_id   : ${agentId}`);
  console.log(`  key_prefix : ${key_prefix}`);
  console.log(`  scopes     : ${scopes.join(', ')}`);
  console.log(`  API KEY    : ${key}`);
  console.log('\n  Email this key to the developer. It is stored only as a sha256 hash; it cannot be recovered.');
  console.log('  Auth: send as `Authorization: Bearer <key>` or `x-api-key: <key>`.');
  process.exit(0);
}

main().catch((e) => {
  console.error('provision failed:', e);
  process.exit(1);
});
