// Buy-loop last mile (2026-07-06) — showcase service listings seed.
//
// Creates real `agent_services` rows for the three showcase services so the
// /market page has genuine listings to display:
//   1. verification      — "Verify-a-claim / HAL fact-check"
//   2. anfis_routing     — "Route-to-best-model"
//   3. reputation_audit  — "Reputation audit + signed attestation"
//
// The three service_type values match REGISTERED service handlers
// (src/services/{verification,anfis-routing,reputation-audit}-service-handler.ts)
// so a contract of each type is actually claimable/fulfillable.
//
// SAFETY — DRY-RUN BY DEFAULT. This script NEVER writes unless invoked with
// `--apply`. With no flag (or `--dry-run`) it only resolves the provider agents
// and PRINTS the exact rows it WOULD insert. Sean / the orchestrator applies it
// after review. It is idempotent: a listing that already exists for the same
// (provider_agent_id, service_type, service_name) is skipped.
//
// Schema (verified against src/types/database.types.ts agent_services):
//   provider_agent_id     uuid   FK repid_agents.id      (required)
//   service_type          text   FK service_categories.category_name (required)
//   service_name          text                            (required)
//   base_price_usdc_raw   number USDC raw units (6 dp)    (required)
//   min_repid_to_purchase number | null
//   description           text | null
//   capability_metadata   json | null
//   active                boolean (default true)
//
// NOTE service_type is an FK to service_categories.category_name — the three
// categories (verification, anfis_routing, reputation_audit) must already exist
// in service_categories or the insert will fail. `--apply` reports that clearly.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read from .env / Railway).
//
// Usage:
//   npx ts-node scripts/seed/seed-showcase-services.ts            # dry-run (default)
//   npx ts-node scripts/seed/seed-showcase-services.ts --dry-run  # explicit dry-run
//   npx ts-node scripts/seed/seed-showcase-services.ts --apply    # ACTUALLY inserts (Sean/orchestrator only)
//
// USDC is 6-decimal, so raw units = dollars * 1_000_000.
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const USDC = (dollars: number) => Math.round(dollars * 1_000_000);

// Showcase listings. provider_agent_name is resolved to repid_agents.id at
// runtime so no uuid is hardcoded. Providers are existing Trinity agents chosen
// to fit each capability:
//   - shofet  (constitutional / judgment)  → verification
//   - orch    (orchestration / routing)    → anfis_routing
//   - veritas (truth / audit)              → reputation_audit
const SHOWCASE_LISTINGS: Array<{
  provider_agent_name: string;
  service_type: 'verification' | 'anfis_routing' | 'reputation_audit';
  service_name: string;
  description: string;
  base_price_usdc_raw: number;
  min_repid_to_purchase: number;
  capability_metadata: Record<string, unknown>;
}> = [
  {
    provider_agent_name: 'shofet',
    service_type: 'verification',
    service_name: 'Verify-a-claim / HAL fact-check',
    description:
      'Cross-LLM HAL fact-check of a factual claim. Returns a hallucination-risk verdict (clean / flagged / vetoed) with per-provider agreement, signed and auditable.',
    base_price_usdc_raw: USDC(0.05),
    min_repid_to_purchase: 0,
    capability_metadata: { handler: 'verification', hal_strictness: 2, cross_llm: true },
  },
  {
    provider_agent_name: 'orch',
    service_type: 'anfis_routing',
    service_name: 'Route-to-best-model',
    description:
      'ANFIS-scored model routing: given a task, returns the best-fit provider/model with a cost/quality rationale. Free-tier-first.',
    base_price_usdc_raw: USDC(0.02),
    min_repid_to_purchase: 0,
    capability_metadata: { handler: 'anfis_routing', free_first: true },
  },
  {
    provider_agent_name: 'veritas',
    service_type: 'reputation_audit',
    service_name: 'Reputation audit + signed attestation',
    description:
      "Audit an agent's RepID history and emit a signed attestation of its current tier + score, suitable for on-chain ERC-8004 reference.",
    base_price_usdc_raw: USDC(0.25),
    min_repid_to_purchase: 1000,
    capability_metadata: { handler: 'reputation_audit', attestation: 'erc8004' },
  },
];

function parseArgs(): { apply: boolean } {
  const argv = process.argv.slice(2);
  // Default is dry-run. Only an explicit --apply flips to a real insert.
  const apply = argv.includes('--apply');
  return { apply };
}

async function main() {
  const { apply } = parseArgs();
  const mode = apply ? 'APPLY (WILL INSERT)' : 'DRY-RUN (no writes)';

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error(
      'FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) must be set.',
    );
    process.exit(1);
  }
  const db = createClient(url, key);

  console.log(`\n=== seed-showcase-services :: ${mode} ===\n`);

  const plannedInserts: Array<Record<string, unknown>> = [];

  for (const listing of SHOWCASE_LISTINGS) {
    // Resolve the provider agent by name → repid_agents.id (no hardcoded uuid).
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier')
      .eq('agent_name', listing.provider_agent_name)
      .maybeSingle();

    if (agentErr) {
      console.error(
        `  [skip] ${listing.service_type}: error resolving provider ${listing.provider_agent_name}: ${agentErr.message}`,
      );
      continue;
    }
    if (!agent) {
      console.error(
        `  [skip] ${listing.service_type}: provider agent '${listing.provider_agent_name}' not found in repid_agents.`,
      );
      continue;
    }

    // Idempotency: skip if a matching listing already exists.
    const { data: existing, error: existErr } = await db
      .from('agent_services')
      .select('id')
      .eq('provider_agent_id', agent.id)
      .eq('service_type', listing.service_type)
      .eq('service_name', listing.service_name)
      .limit(1);

    if (existErr) {
      console.error(
        `  [warn] ${listing.service_type}: could not check for existing listing: ${existErr.message}`,
      );
    }
    if (existing && existing.length > 0) {
      console.log(
        `  [exists] ${listing.service_type} "${listing.service_name}" already listed for ${agent.agent_name} (id ${existing[0]!.id}) — skipping.`,
      );
      continue;
    }

    const row = {
      provider_agent_id: agent.id,
      service_type: listing.service_type,
      service_name: listing.service_name,
      description: listing.description,
      base_price_usdc_raw: listing.base_price_usdc_raw,
      min_repid_to_purchase: listing.min_repid_to_purchase,
      capability_metadata: listing.capability_metadata,
      active: true,
    };
    plannedInserts.push({ ...row, __provider_name: agent.agent_name });

    console.log(
      `  [plan] ${listing.service_type} :: "${listing.service_name}"\n` +
        `         provider  = ${agent.agent_name} (${agent.id})\n` +
        `         price     = ${listing.base_price_usdc_raw} raw USDC ($${(listing.base_price_usdc_raw / 1e6).toFixed(2)})\n` +
        `         min_repid = ${listing.min_repid_to_purchase}\n`,
    );
  }

  if (plannedInserts.length === 0) {
    console.log('\nNothing to insert (all showcase listings already exist or providers missing).\n');
    return;
  }

  if (!apply) {
    console.log(
      `\nDRY-RUN complete: ${plannedInserts.length} row(s) WOULD be inserted into agent_services.\n` +
        `Re-run with --apply (Sean / orchestrator only) to write them.\n`,
    );
    return;
  }

  // --apply path: insert the planned rows (strip the display-only helper field).
  const toInsert = plannedInserts.map(({ __provider_name, ...r }) => r);
  const { data, error } = await db.from('agent_services').insert(toInsert).select('id, service_type, service_name');
  if (error) {
    console.error(`\nINSERT FAILED: ${error.message}`);
    if (/foreign key|service_categories/i.test(error.message)) {
      console.error(
        'HINT: service_type is an FK to service_categories.category_name — ensure the ' +
          'verification / anfis_routing / reputation_audit categories exist there first.',
      );
    }
    process.exit(1);
  }
  console.log(`\nAPPLIED: inserted ${data?.length ?? 0} showcase listing(s):`);
  for (const r of data ?? []) {
    console.log(`  + ${r.service_type} :: "${r.service_name}" (id ${r.id})`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('seed-showcase-services failed:', e?.message ?? String(e));
  process.exit(1);
});
