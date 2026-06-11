#!/usr/bin/env node
// provider-quota-registry.mjs  --  CC INFRA sprint 2026-06-10
// ---------------------------------------------------------------------------
// One place that answers, at any moment: which LLM families are UP (key present)
// and how much FREE quota each has left today. This is the input a drain
// scheduler reads to decide where to send the next batch of free compute.
//
// Reuses the existing `free_tier_usage` Supabase table (provider / monthly_limit
// / requests_used / reset_date / user_id) as the OPTIONAL usage overlay. The
// table is currently empty; this script carries the canonical quota SPEC itself
// so it is useful with zero rows, and can SEED the table (--seed) to start
// tracking.
//
// Usage:
//   node scripts/provider-quota-registry.mjs            # print the live table
//   node scripts/provider-quota-registry.mjs --json     # machine-readable (scheduler)
//   node scripts/provider-quota-registry.mjs --seed     # print upsert SQL for free_tier_usage
//   node scripts/provider-quota-registry.mjs --seed --apply   # apply the upsert (needs SUPABASE creds)
//
// Key presence is read from process.env. To populate it from the local Railway
// env dump for a one-off run:
//   Get-Content C:\Users\Cash4\litellm_vars.txt | ForEach-Object { if ($_ -match '^([A-Z0-9_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1],$Matches[2],'Process') } }
//   node scripts/provider-quota-registry.mjs
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const SEED = args.has('--seed');
const APPLY = args.has('--apply');

// Canonical provider quota registry.
// tier:  local = on-box Ollama (no limit, the quorum FLOOR)
//        free  = free tier (used first)
//        cheap = cheap paid anchor (used when free can't form a quorum)
//        paid  = elite / last resort
// Quotas are REFERENCE ceilings for free tiers (verify against provider
// dashboards; they drift). rpd/tpd null = not published / not the binding limit.
// `model` matches the model_name in litellm_config.yaml so the scheduler can
// route straight through the proxy.
const PROVIDERS = [
  // ---- LOCAL FLOOR ----
  { provider: 'ollama',      family: 'local',    tier: 'local', model: 'ollama/llama3.1',  envVar: null,                  rpm: Infinity, rpd: Infinity, tpm: Infinity, tpd: Infinity, reset: 'n/a (local)',  notes: 'never rate-limits; quorum floor' },

  // ---- FREE TIER ----
  { provider: 'groq',        family: 'llama',    tier: 'free',  model: 'groq-llama',        envVar: 'GROQ_API_KEY',        rpm: 30,  rpd: 14400, tpm: 6000,   tpd: 500000,  reset: 'rolling 1m / 1d', notes: 'llama-3.1-8b-instant (8b has far higher RPM than 70b)' },
  { provider: 'cerebras',    family: 'glm',      tier: 'free',  model: 'cerebras-llama',    envVar: 'CEREBRAS_API_KEY',    rpm: 30,  rpd: 14400, tpm: 60000,  tpd: 1000000, reset: 'rolling 1m / 1d', notes: 'zai-glm-4.7 (llama3.1-* not on this key)' },
  { provider: 'gemini',      family: 'gemini',   tier: 'free',  model: 'gemini-flash',      envVar: 'GEMINI_API_KEY',      rpm: 15,  rpd: 1500,  tpm: 1000000,tpd: null,    reset: 'rolling 1m / daily', notes: 'gemini-2.0-flash free; 429s under burst -> needs 2nd key' },
  { provider: 'huggingface', family: 'mixed',    tier: 'free',  model: 'hf/qwen-2.5-72b',   envVar: 'HUGGINGFACE_API_TOKEN', rpm: 10, rpd: null, tpm: null,   tpd: null,    reset: 'monthly credits', notes: 'Inference API; monthly credit pool, not strict rpm' },
  { provider: 'sambanova',   family: 'llama',    tier: 'free',  model: 'sambanova-llama',   envVar: 'SAMBANOVA_API_KEY',   rpm: 20,  rpd: null,  tpm: null,   tpd: null,    reset: 'rolling', notes: 'free tier; independent llama host' },
  { provider: 'siliconflow', family: 'qwen',     tier: 'free',  model: 'siliconflow-qwen',  envVar: 'SILICONFLOW_API_KEY', rpm: 20,  rpd: null,  tpm: null,   tpd: null,    reset: 'credit pool', notes: 'free credits; qwen host' },
  { provider: 'cohere',      family: 'cohere',   tier: 'free',  model: 'cohere-command',    envVar: 'COHERE_API_KEY',      rpm: 20,  rpd: 1000,  tpm: null,   tpd: null,    reset: 'trial: ~1000 calls/mo', notes: 'trial key; command-r' },

  // ---- CHEAP PAID ANCHORS ----
  { provider: 'xai',         family: 'grok',     tier: 'cheap', model: 'grok',              envVar: 'XAI_API_KEY',         rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'grok-4.3; paid credits; reliable anchor' },
  { provider: 'deepseek',    family: 'deepseek', tier: 'cheap', model: 'deepseek-chat',     envVar: 'DEEPSEEK_API_KEY',    rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'cheap; returned 402 unfunded 2026-06-03 -- verify balance' },
  { provider: 'mistral',     family: 'mistral',  tier: 'cheap', model: 'mistral-medium',    envVar: 'MISTRAL_API_KEY',     rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'live proxy returned Unauthorized -- key missing/invalid' },

  // ---- ELITE / LAST RESORT ----
  { provider: 'together',    family: 'llama',    tier: 'paid',  model: 'together-fallback', envVar: 'TOGETHER_API_KEY',    rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'missing credentials on live proxy' },
  { provider: 'anthropic',   family: 'anthropic',tier: 'paid',  model: 'anthropic-claude',  envVar: 'ANTHROPIC_API_KEY',   rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'claude-haiku-4-5; elite escalation only' },
  { provider: 'openrouter',  family: 'mixed',    tier: 'paid',  model: 'openrouter-fallback',envVar: 'OPENROUTER_API_KEY', rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'openrouter/auto; last-resort breadth' },
  { provider: 'fireworks',   family: 'mixed',    tier: 'paid',  model: null,                envVar: 'FIREWORKS_API_KEY',   rpm: null, rpd: null, tpm: null,   tpd: null,    reset: 'credit balance', notes: 'account suspended 2026-06-04; out of quorum until restored' },
];

const num = (n) => n === Infinity ? 'inf' : (n == null ? '-' : String(n));

function keyState(p) {
  if (p.tier === 'local') return 'LOCAL';
  const v = p.envVar ? process.env[p.envVar] : null;
  return v && v.trim() ? 'present' : 'MISSING';
}

async function dbOverlay() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- usage overlay skipped', rows: [] };
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb
      .from('free_tier_usage')
      .select('provider, monthly_limit, requests_used, reset_date');
    if (error) return { ok: false, reason: `query error: ${error.message}`, rows: [] };
    return { ok: true, rows: data || [] };
  } catch (e) {
    return { ok: false, reason: `supabase-js unavailable: ${e.message}`, rows: [] };
  }
}

function buildRegistry(overlayRows) {
  const byProv = new Map(overlayRows.map((r) => [String(r.provider).toLowerCase(), r]));
  return PROVIDERS.map((p) => {
    const u = byProv.get(p.provider.toLowerCase());
    const remaining = u && u.monthly_limit != null
      ? Math.max(0, Number(u.monthly_limit) - Number(u.requests_used || 0))
      : null;
    return {
      ...p,
      key: keyState(p),
      monthly_limit: u ? u.monthly_limit : null,
      requests_used: u ? u.requests_used : null,
      remaining_month: remaining,
      reset_date: u ? u.reset_date : null,
    };
  });
}

function printTable(reg, overlay) {
  const up = reg.filter((r) => r.key === 'present' || r.key === 'LOCAL');
  const freeUp = up.filter((r) => r.tier === 'free' || r.tier === 'local');
  console.log('PROVIDER QUOTA REGISTRY  (2026-06-10)  --  free-tier ceilings are reference; verify on dashboards');
  console.log('='.repeat(118));
  console.log(
    pad('PROVIDER', 12) + pad('FAMILY', 10) + pad('TIER', 7) + pad('KEY', 9) +
    pad('RPM', 6) + pad('RPD', 8) + pad('TPM', 9) + pad('RESET', 20) + 'PROXY MODEL'
  );
  console.log('-'.repeat(118));
  for (const r of reg) {
    console.log(
      pad(r.provider, 12) + pad(r.family, 10) + pad(r.tier, 7) + pad(r.key, 9) +
      pad(num(r.rpm), 6) + pad(num(r.rpd), 8) + pad(num(r.tpm), 9) +
      pad(r.reset, 20) + (r.model || '(not in proxy)')
    );
  }
  console.log('-'.repeat(118));
  console.log(`FREE/LOCAL families reachable now: ${freeUp.length}  [${freeUp.map((r) => r.provider).join(', ')}]`);
  const quorumOk = freeUp.length >= 3;
  console.log(`Quorum floor (>=3 free/local reachable): ${quorumOk ? 'OK' : 'AT RISK'}` +
    (freeUp.some((r) => r.tier === 'local') ? '  (ollama floor present -> always >=1)' : '  (NO local floor -> add Ollama)'));
  console.log(`Usage overlay: ${overlay.ok ? overlay.rows.length + ' free_tier_usage rows' : overlay.reason}`);
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }

function seedSql() {
  // free_tier_usage requires user_id NOT NULL; use a stable system uuid for the
  // global provider quota rows so a drain scheduler can decrement requests_used.
  const SYS = '00000000-0000-0000-0000-0000000005ee'; // 'see'd system row
  const rows = PROVIDERS.filter((p) => p.tier !== 'local').map((p) => {
    const limit = p.rpd != null ? p.rpd : (p.rpm != null ? p.rpm * 60 : 100000);
    return `  ('${p.provider}', ${limit}, 0, (now() + interval '1 day')::timestamptz, '${SYS}', now())`;
  });
  return [
    '-- Seed free_tier_usage with one global quota row per provider (CC 2026-06-10).',
    '-- monthly_limit here = a daily ceiling proxy (rpd, or rpm*60); adjust per provider.',
    'INSERT INTO free_tier_usage (provider, monthly_limit, requests_used, reset_date, user_id, updated_at) VALUES',
    rows.join(',\n'),
    'ON CONFLICT DO NOTHING;',
  ].join('\n');
}

async function applySeed() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('--apply needs SUPABASE_URL + SUPABASE_SERVICE_KEY'); process.exit(2); }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const SYS = '00000000-0000-0000-0000-0000000005ee';
  const payload = PROVIDERS.filter((p) => p.tier !== 'local').map((p) => ({
    provider: p.provider,
    monthly_limit: p.rpd != null ? p.rpd : (p.rpm != null ? p.rpm * 60 : 100000),
    requests_used: 0,
    reset_date: new Date(Date.now() + 86400000).toISOString(),
    user_id: SYS,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await sb.from('free_tier_usage').upsert(payload, { onConflict: 'provider,user_id', ignoreDuplicates: true });
  if (error) { console.error('seed apply error:', error.message); process.exit(1); }
  console.log(`seeded ${payload.length} provider rows into free_tier_usage`);
}

(async () => {
  if (SEED && APPLY) { await applySeed(); return; }
  if (SEED) { console.log(seedSql()); return; }
  const overlay = await dbOverlay();
  const reg = buildRegistry(overlay.rows);
  if (JSON_OUT) {
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), providers: reg }, null, 2));
  } else {
    printTable(reg, overlay);
  }
})();
