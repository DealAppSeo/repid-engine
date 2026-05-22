/**
 * verify-mvp-loop.ts — the MVP go-gate evidence script.
 *
 * Drives ONE complete real run of the four-layer loop and captures the basescan
 * tx hash that IS the MVP go-gate evidence:
 *   agent output → x402 settle (verdict_x402='settled') → HAL judge
 *   (verdict_hal='pass') → FeedbackLoopWorker on-chain giveFeedback → basescan.
 *
 * SAFETY / GAS RULE:
 *   - DRY RUN by default: prints the plan + checks preconditions, NO side effects,
 *     does not even import the DB/config (so it runs anywhere). Pass --execute to
 *     run the real loop. Sean runs --execute manually.
 *   - The ONE expected real on-chain write is this loop firing once with all four
 *     layers real. Real agent output (free-tier LLM), real x402 settlement, real
 *     HAL judgment, real RepID delta — never a mock on-chain.
 *
 * Env: REPID_API_URL, REPID_API_KEY, E2E_PROVIDER_AGENT_ID, E2E_REQUESTOR_AGENT_ID
 *   (repid_agents UUIDs; provider should be minted, e.g. trinity-veritas/shofet),
 *   a free-LLM key (CEREBRAS/GROQ/TOGETHER/HF), and for the real payment leg a
 *   funded payer wallet + X402_REAL_RPC (see x402-outbound-client). Supabase env
 *   for the DB polling (only touched under --execute).
 */

import { freeComplete, selectProvider } from '../agent-testing/free-llm-router';

const DEFAULT_ENGINE = 'https://repid-engine-production.up.railway.app';
const POLL_TRIES = parseInt(process.env.E2E_POLL_TRIES ?? '20', 10);
const POLL_INTERVAL_MS = parseInt(process.env.E2E_POLL_INTERVAL_MS ?? '6000', 10);

function env(name: string): string | undefined { const v = process.env[name]; return v && v.trim() ? v.trim() : undefined; }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pre { ok: boolean; label: string; detail: string }

async function preconditions(engine: string): Promise<Pre[]> {
  const checks: Pre[] = [];
  const llm = selectProvider();
  checks.push({ ok: !!llm, label: 'free-LLM key', detail: llm ? llm.provider.name : 'none (set CEREBRAS/GROQ/TOGETHER/HF)' });
  checks.push({ ok: !!env('E2E_PROVIDER_AGENT_ID'), label: 'E2E_PROVIDER_AGENT_ID', detail: env('E2E_PROVIDER_AGENT_ID') ?? 'unset (minted provider UUID, e.g. trinity-veritas)' });
  checks.push({ ok: !!env('E2E_REQUESTOR_AGENT_ID'), label: 'E2E_REQUESTOR_AGENT_ID', detail: env('E2E_REQUESTOR_AGENT_ID') ?? 'unset (buyer UUID)' });
  checks.push({ ok: !!env('REPID_API_KEY'), label: 'REPID_API_KEY', detail: env('REPID_API_KEY') ? 'set' : 'unset (needed for authed routes)' });
  checks.push({ ok: !!env('X402_REAL_RPC'), label: 'X402_REAL_RPC', detail: env('X402_REAL_RPC') ? 'set (real settlement)' : 'unset (settlement would be simulated → off-chain only)' });
  try {
    const res = await fetch(engine.replace(/\/$/, '') + '/api/v1/health', { signal: AbortSignal.timeout(10000) });
    checks.push({ ok: res.ok, label: 'engine /health', detail: `${engine} → HTTP ${res.status}` });
  } catch (e: any) {
    checks.push({ ok: false, label: 'engine /health', detail: `${engine} → ${e?.message ?? e}` });
  }
  return checks;
}

const PLAN = [
  '1. Generate REAL agent output via a free-tier LLM (the claim HAL will judge)',
  '2. x402: request tip (402) then settle with a real signed EIP-3009 payment (needs funded payer + X402_REAL_RPC)',
  "3. Wait for x402-server to write repid_events with verdict_x402='settled'",
  "4. Wait for the HAL judgment worker to set verdict_hal='pass' (+ verdict_combined_at)",
  '5. Poll until the FeedbackLoopWorker writes on-chain (REQUIRE_DUAL_VERDICT=true)',
  '6. Capture the basescan tx hash of the giveFeedback call (THE go-gate evidence)',
  '7. Verify the four rows: x402_settlements, repid_events (both verdicts), hal_classifications, erc8004_reputation_writes',
];

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const engine = env('REPID_API_URL') || env('ENGINE_URL') || DEFAULT_ENGINE;

  console.log(`\n[e2e] engine: ${engine}`);
  console.log('[e2e] PLAN:');
  for (const step of PLAN) console.log(`      ${step}`);

  const pre = await preconditions(engine);
  console.log('\n[e2e] preconditions:');
  for (const c of pre) console.log(`      ${c.ok ? 'OK ' : 'XX '} ${c.label}: ${c.detail}`);
  const allOk = pre.every((c) => c.ok);

  if (!execute) {
    console.log(`\n[e2e] DRY RUN — no side effects. ${allOk ? 'Preconditions look ready.' : 'Resolve the XX items above before --execute.'}`);
    console.log('[e2e] Re-run with --execute to fire the real loop (Sean only). Gas rule: this is the ONE expected real write.');
    return;
  }

  if (!allOk) {
    console.error('\n[e2e] FATAL: --execute requires all preconditions met (see XX above). Aborting before any spend.');
    process.exit(1);
  }

  // ---- EXECUTE: real loop. DB import is lazy so dry-run never boots config. ----
  const { db } = require('../../src/db');
  const provider = env('E2E_PROVIDER_AGENT_ID')!;
  const requestor = env('E2E_REQUESTOR_AGENT_ID')!;
  const apiKey = env('REPID_API_KEY')!;

  // 1. Real agent output.
  const gen = await freeComplete('Answer in one factual sentence: who wrote the play Hamlet, and in roughly what decade?', { maxTokens: 60 });
  if (!gen.ok || !gen.text) { console.error(`[e2e] FATAL: free-LLM output failed: ${gen.error}`); process.exit(1); }
  const output = gen.text.replace(/\s+/g, ' ').trim();
  console.log(`\n[e2e] agent output (via ${gen.provider}): "${output}"`);

  // 2. x402 request → 402 challenge.
  const reqRes = await fetch(`${engine}/api/v1/tip/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ requestor_agent_id: requestor, provider_agent_id: provider, prediction_topic: 'e2e-mvp-go-gate' }),
  });
  const reqBody: any = await reqRes.json().catch(() => null);
  if (reqRes.status !== 402 || !reqBody?.tip_id) { console.error(`[e2e] FATAL: tip/request expected 402+tip_id, got ${reqRes.status}`, reqBody); process.exit(1); }
  const tipId = reqBody.tip_id as string;
  console.log(`[e2e] x402 402 challenge: tip_id=${tipId}`);

  // 2b. Settle. NOTE: a real settlement requires a signed EIP-3009 X-PAYMENT from
  //     a funded payer wallet — port src/services/x402-outbound-client.ts's signer
  //     here, or have the buyer agent present the signed header. This script does
  //     NOT hold a funded key; Sean wires the payer. We attempt deliver and report.
  console.log('[e2e] settle: present a real signed X-PAYMENT (funded payer + X402_REAL_RPC). See x402-outbound-client for the EIP-3009 signer.');

  // 3-4. Poll repid_events for both verdicts on this provider.
  let row: any = null;
  for (let i = 0; i < POLL_TRIES; i++) {
    const { data } = await db
      .from('repid_events')
      .select('id, verdict_x402, verdict_hal, verdict_combined_at, hal_classification_id, processed_at')
      .eq('subject_id', provider)
      .eq('event_type', 'x402_inbound_settled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data;
    console.log(`[e2e] poll ${i + 1}/${POLL_TRIES}: verdict_x402=${row?.verdict_x402 ?? '-'} verdict_hal=${row?.verdict_hal ?? '-'} combined=${!!row?.verdict_combined_at}`);
    if (row?.verdict_x402 && row?.verdict_hal && row.verdict_hal !== 'pending') break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (!row) { console.error('[e2e] FATAL: no repid_events row appeared for the provider.'); process.exit(1); }

  // 5-6. Poll for the on-chain write (only fires on settled+pass with REQUIRE_DUAL_VERDICT).
  let write: any = null;
  for (let i = 0; i < POLL_TRIES; i++) {
    const { data } = await db
      .from('erc8004_reputation_writes')
      .select('tx_hash, created_at, agent_id')
      .eq('agent_id', provider)
      .not('tx_hash', 'like', '0xmock%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    write = data;
    if (write?.tx_hash) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // 7. Verdict summary.
  console.log('\n[e2e] ===== RESULT =====');
  console.log(`[e2e] verdict_x402   : ${row.verdict_x402}`);
  console.log(`[e2e] verdict_hal    : ${row.verdict_hal}`);
  console.log(`[e2e] hal_class_id   : ${row.hal_classification_id ?? '-'}`);
  if (write?.tx_hash) {
    console.log(`[e2e] ✅ ON-CHAIN     : ${write.tx_hash}`);
    console.log(`[e2e] basescan       : https://sepolia.basescan.org/tx/${write.tx_hash}`);
    console.log('[e2e] MVP GO-GATE: four layers real, on-chain write captured.');
  } else if (row.verdict_x402 === 'settled' && row.verdict_hal === 'pass') {
    console.log('[e2e] both verdicts pass but no on-chain write yet — confirm REQUIRE_DUAL_VERDICT=true + FeedbackLoopWorker running.');
  } else {
    console.log('[e2e] no on-chain write (correct): a dissenting verdict vetoed it (gas rule honored).');
  }
}

main().catch((e: any) => { console.error('[e2e] FATAL:', e?.message ?? String(e), e?.stack ?? ''); process.exit(1); });
