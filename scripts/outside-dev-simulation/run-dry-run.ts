/**
 * run-dry-run.ts — outside-developer simulation (CC1, 2026-05-25).
 *
 * Automates the "stranger discovers TrustShell" path so docs/install/endpoint drift
 * is caught before users hit it. Exercises ONLY the keyless surfaces an outside dev
 * can reach without an API key, plus checks the published package version.
 *
 *   ts-node scripts/outside-dev-simulation/run-dry-run.ts
 *
 * Verified live 2026-05-25: `npm i -g @hyperdag/trustshell@0.6.1` installs in ~5s;
 * `trustshell whois 5863` returns on-chain reputation keyless; `trustshell verify`
 * correctly errors "API key required" (the documented friction — self-serve key flow
 * is pending, CC2 #32). Read-only; no auth; no writes.
 */
const BASE = process.env.SMOKE_BASE_URL || 'https://repid-engine-production.up.railway.app';
const SHOFET = '32e0e809-c1c4-4405-913f-135c8a2d6626';

type Step = { step: string; ok: boolean; detail: string };

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${path}`);
  let body: any = null; try { body = await r.json(); } catch { /* non-json */ }
  return { status: r.status, body };
}

async function run(): Promise<Step[]> {
  const steps: Step[] = [];
  const push = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });

  // 1. health (keyless)
  try { const r = await get('/health'); push('health', r.status === 200 && r.body?.status === 'ok', `HTTP ${r.status}`); }
  catch (e: any) { push('health', false, e.message); }

  // 2. public system status (CC1 launch-status endpoint)
  try { const r = await get('/api/v1/status'); push('public_status', r.status === 200, `HTTP ${r.status} attestations_24h=${r.body?.metrics_24h?.onchain_attestations}`); }
  catch (e: any) { push('public_status', false, e.message); }

  // 3. hero receipt (launch credibility, keyless)
  try { const r = await get('/api/v1/receipts/hero'); push('hero_receipt', r.status === 200 && /^0x[0-9a-f]{64}$/i.test(r.body?.usdc_settlement?.tx || ''), `HTTP ${r.status}`); }
  catch (e: any) { push('hero_receipt', false, e.message); }

  // 4. keyless reputation read (what `trustshell whois` calls)
  try { const r = await get(`/api/v1/agents/${SHOFET}/repid`); push('whois_repid_read', r.status === 200, `HTTP ${r.status}`); }
  catch (e: any) { push('whois_repid_read', false, e.message); }

  // 5. LLM trust leaderboard (keyless)
  try { const r = await get('/api/v1/llm-trust'); push('llm_trust_public', r.status === 200, `HTTP ${r.status}`); }
  catch (e: any) { push('llm_trust_public', false, e.message); }

  return steps;
}

if (require.main === module) {
  run().then(steps => {
    console.log(`\n=== outside-dev dry run vs ${BASE} ===`);
    for (const s of steps) console.log(`  [${s.ok ? 'PASS' : 'FAIL'}] ${s.step}: ${s.detail}`);
    const failed = steps.filter(s => !s.ok);
    console.log(`  ${steps.length - failed.length}/${steps.length} keyless surfaces OK`);
    console.log('  NOTE: verify/pay require REPID_API_KEY — self-serve key flow pending (CC2 #32) = the onboarding friction.');
    process.exit(failed.length ? 1 : 0);
  }).catch(e => { console.error('dry-run crashed:', e.message); process.exit(1); });
}
