/**
 * ANFIS broker enablement — STAGING artifact.
 *
 * Mints one `llm_complete`-scoped agent API key per Trinity-12 agent so each
 * agent can call the server-side broker (POST /api/v1/llm/complete with an
 * agent_id) instead of holding provider keys itself. Reuses issueAgentApiKey
 * (src/auth/api-keys.ts), which stores ONLY the sha256 hash — the raw key is
 * shown exactly once, at issue time, under --apply.
 *
 * This script does NOT flip any live flag. It mints keys; the actual
 * enablement flips (ENGINE_LLM_PROXY, REPID_API_URL/REPID_API_KEY per agent,
 * ROUTER_STRICT_COST_ORDER) are Sean-GO Railway env changes documented in
 * reports/2026-07-27/ANFIS_ENABLEMENT_RUNBOOK.md.
 *
 * Usage:
 *   # DRY-RUN (default) — prints what it WOULD mint, writes NOTHING, no keys:
 *   SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. npx ts-node scripts/anfis/mint-agent-keys.ts
 *
 *   # APPLY — actually mints + prints each raw key ONCE (copy immediately):
 *   SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. npx ts-node scripts/anfis/mint-agent-keys.ts --apply
 *
 * Flags:
 *   --apply            actually mint (default is dry-run)
 *   --scopes a,b       scopes to grant (default: llm_complete)
 *   --label <str>      key label/name (default: anfis-broker-2026-07-27)
 *   --agents a,b       comma list of agent NAMES to mint for (default: the Trinity 12)
 *   --skip-existing    skip an agent that already has a non-revoked key with this label
 *
 * SAFETY: never prints an existing key value (they are unrecoverable hashes);
 * only prints the freshly-issued raw key, and only under --apply.
 */
import { db } from '../../src/db';
import { issueAgentApiKey } from '../../src/auth/api-keys';
import { TRINITY_12_AGENT_NAMES } from '../../src/constants/public-surfaces';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const APPLY = hasFlag('apply');
const SKIP_EXISTING = hasFlag('skip-existing');
const SCOPES = (arg('scopes') ?? 'llm_complete').split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = arg('label') ?? 'anfis-broker-2026-07-27';
const AGENT_NAMES = (arg('agents')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [...TRINITY_12_AGENT_NAMES];

interface AgentRow { id: string; agent_name: string; }

async function resolveAgents(names: string[]): Promise<{ found: AgentRow[]; missing: string[] }> {
  const found: AgentRow[] = [];
  const missing: string[] = [];
  for (const rawName of names) {
    const name = rawName.startsWith('trinity-') ? rawName : `trinity-${rawName}`;
    const { data, error } = await db
      .from('repid_agents')
      .select('id, agent_name')
      .eq('agent_name', name)
      .maybeSingle();
    if (error) {
      console.warn(`[mint] lookup error for ${name}: ${error.message}`);
      missing.push(name);
      continue;
    }
    if (data && data.id) {
      found.push({ id: data.id, agent_name: data.agent_name });
    } else {
      missing.push(name);
    }
  }
  return { found, missing };
}

/** True if this agent already has a non-revoked key carrying LABEL (checked only under --skip-existing). */
async function hasExistingKey(agentId: string): Promise<boolean> {
  const { data, error } = await db
    .from('agent_api_keys')
    .select('id')
    .eq('agent_id', agentId)
    .eq('name', LABEL)
    .is('revoked_at', null)
    .limit(1);
  if (error) {
    console.warn(`[mint] existing-key check failed for ${agentId}: ${error.message}`);
    return false;
  }
  return !!(data && data.length > 0);
}

async function main() {
  console.log('=== ANFIS broker key mint (staging) ===');
  console.log(`  mode       : ${APPLY ? 'APPLY (will mint + print raw keys ONCE)' : 'DRY-RUN (no writes, no keys)'}`);
  console.log(`  scopes     : ${SCOPES.join(', ')}`);
  console.log(`  label      : ${LABEL}`);
  console.log(`  agents     : ${AGENT_NAMES.length} requested`);
  console.log('');

  if (!SCOPES.includes('llm_complete')) {
    console.error('[mint] refusing: scopes must include "llm_complete" (broker gate). Add it via --scopes.');
    process.exit(1);
  }

  const { found, missing } = await resolveAgents(AGENT_NAMES);
  if (missing.length > 0) {
    console.warn(`[mint] ${missing.length} agent name(s) not found in repid_agents: ${missing.join(', ')}`);
  }
  if (found.length === 0) {
    console.error('[mint] no resolvable agents; nothing to do.');
    process.exit(1);
  }

  let minted = 0;
  let skipped = 0;
  for (const agent of found) {
    if (SKIP_EXISTING) {
      const exists = await hasExistingKey(agent.id);
      if (exists) {
        console.log(`  - ${agent.agent_name} (${agent.id}): SKIP (existing '${LABEL}' key)`);
        skipped++;
        continue;
      }
    }

    if (!APPLY) {
      console.log(`  - ${agent.agent_name} (${agent.id}): WOULD mint key [scopes=${SCOPES.join('+')}, label=${LABEL}]`);
      continue;
    }

    try {
      const { key, key_prefix } = await issueAgentApiKey(agent.id, LABEL, SCOPES);
      minted++;
      console.log('\n  === MINTED (copy now — shown once) ===');
      console.log(`    agent_name : ${agent.agent_name}`);
      console.log(`    agent_id   : ${agent.id}`);
      console.log(`    key_prefix : ${key_prefix}`);
      console.log(`    scopes     : ${SCOPES.join(', ')}`);
      console.log(`    API KEY    : ${key}`);
      console.log(`    -> set on this agent's Railway service: REPID_API_KEY=<API KEY>, REPID_API_URL=<engine base>`);
    } catch (e) {
      console.error(`  - ${agent.agent_name} (${agent.id}): MINT FAILED: ${(e as Error).message}`);
    }
  }

  console.log('');
  if (APPLY) {
    console.log(`[mint] done. minted=${minted} skipped=${skipped} missing=${missing.length}`);
    console.log('[mint] keys are stored only as sha256 hashes and cannot be recovered. Distribute now.');
    console.log('[mint] NEXT (Sean GO): follow reports/2026-07-27/ANFIS_ENABLEMENT_RUNBOOK.md to flip the enablement env vars.');
  } else {
    console.log(`[mint] DRY-RUN complete. resolvable=${found.length} missing=${missing.length}. Re-run with --apply to mint.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('mint-agent-keys failed:', e);
  process.exit(1);
});
