/**
 * scripts/firecrawl-smoke.ts — fire ONE real Firecrawl call to verify the live
 * rollout path (PR-2, CC1 2026-05-26).
 *
 * Hits the prod /api/v1/mcp-call endpoint as a known allowlisted agent
 * (trinity-nexus by default). Requires:
 *   REPID_API_KEY              — a valid API key (any tier; this hits an
 *                                authed endpoint via /mcp-call)
 *   REPID_API_BASE             — defaults to the Railway prod URL
 *   FIRECRAWL_SMOKE_AGENT_ID   — defaults to trinity-nexus UUID
 *   FIRECRAWL_SMOKE_QUERY      — defaults to 'ERC-8004 reputation registry'
 *
 * Cost: 1 Firecrawl credit (~$0.00083). Sean fires once after merge to verify
 * the end-to-end chain works; this is NOT an automated smoke (no cron, no
 * burning credits on every deploy).
 *
 * Usage:
 *   FIRECRAWL_SMOKE_AGENT_ID=<uuid> REPID_API_KEY=<key> \
 *     npx ts-node scripts/firecrawl-smoke.ts
 */

const NEXUS_UUID = '848da285-93c5-4e99-a989-3d9e49ebed09'; // trinity-nexus
const TORCH_UUID = '9c0dc740-8c16-4862-ad62-9ba3d515369d'; // trinity-torch (alt)

async function main(): Promise<void> {
  const base = process.env.REPID_API_BASE || 'https://repid-engine-production.up.railway.app';
  const apiKey = process.env.REPID_API_KEY;
  const agentId = process.env.FIRECRAWL_SMOKE_AGENT_ID || NEXUS_UUID;
  const query = process.env.FIRECRAWL_SMOKE_QUERY || 'ERC-8004 reputation registry';

  if (!apiKey) {
    console.error('✗ REPID_API_KEY not set — set it before running this smoke.');
    process.exit(2);
  }

  console.log(`→ POST ${base}/api/v1/mcp-call`);
  console.log(`  agentId  = ${agentId} ${agentId === NEXUS_UUID ? '(trinity-nexus)' : agentId === TORCH_UUID ? '(trinity-torch)' : '(custom)'}`);
  console.log(`  toolName = firecrawl`);
  console.log(`  query    = "${query}" (limit 3, action=search)`);
  console.log('');

  const t0 = Date.now();
  const resp = await fetch(`${base}/api/v1/mcp-call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      agentId,
      toolName: 'firecrawl',
      params: { action: 'search', query, limit: 3 },
    }),
  });
  const elapsed = Date.now() - t0;
  const body: any = await resp.json().catch(() => ({}));

  console.log(`← HTTP ${resp.status} in ${elapsed}ms`);
  console.log('');
  console.log(JSON.stringify(body, null, 2));
  console.log('');

  if (!resp.ok) {
    console.error('✗ Non-2xx — investigate. Common causes: scope (agentId not in allowlist), rate limit, missing FIRECRAWL_API_KEY on Railway.');
    process.exit(1);
  }

  if (body.allowed === false) {
    console.error(`✗ Call gated: ${body.blockedReason}`);
    if (String(body.blockedReason ?? '').includes('FIRECRAWL_API_KEY')) {
      console.error('  → FIRECRAWL_API_KEY is unset on Railway. Sean: set it under repid-engine env.');
    }
    process.exit(1);
  }

  const result: any = body.result;
  const calledFirecrawl = result && result.firecrawl === true;
  const action = result?.action ?? '(none)';
  const usd = body.costUsd ?? 0;

  if (!calledFirecrawl) {
    console.error(`✗ Response did not include firecrawl=true (action=${action}). Stub path returned instead.`);
    process.exit(1);
  }

  console.log(`✓ Firecrawl live: action=${action}, cost_usd=$${usd}, latency_ms=${body.latencyMs ?? 'n/a'}.`);
  console.log('  → Verify by querying /api/v1/firecrawl/stats; the call count should have incremented by 1.');
}

main().catch((e) => {
  console.error('✗ Unexpected error:', e?.message ?? e);
  process.exit(1);
});
