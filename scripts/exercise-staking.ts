/**
 * R4 (GA): exercise economy beyond N=1 using XC's recordDeposit/recordSponsorship iface from stake-vault/sponsorship.ts.
 * Calls >1 varied (sponsors + deposits where possible). Results visible on live dashboard.
 * Run after npm ci. Uses real agent short names from repid_agents (VERITAS etc for sponsorship path).
 * recordDeposit targets builders table (may simulate). Gate: total stakes/sponsors rows increase, visible via /api/demo or trustshell dashboard.
 * Citations: src/services/stake-vault.ts:235 (recordDeposit), sponsorship.ts:29 (recordSponsorship), exercise script.
 */
import 'dotenv/config';
import { recordDeposit } from '../src/services/stake-vault';
import { recordSponsorship } from '../src/services/sponsorship';

async function main() {
  console.log('[EXERCISE-STAKING R4-GA] beyond N=1 (parallel XC R4 complete)');
  // Use real short names observed in agent_stakes (UPPER, no trinity- prefix in data)
  // Sponsorship normalizes internally.
  const s1 = await recordSponsorship('VERITAS', 'HDM', 2_000_000, 'ga-r4-ex1'); // 2 USDC sponsor
  const s2 = await recordSponsorship('GCM', 'TORCH', 3_500_000, 'ga-r4-ex2');
  const s3 = await recordSponsorship('HDM', 'VERITAS', 1_000_000, 'ga-r4-ex3');
  console.log('[R4] sponsorship calls:', { s1, s2, s3 });

  // Deposits (builder path; use known builder ids or addresses from ground; may be limited)
  const d1 = await recordDeposit('0xt0ken15ee295a1b184e6cddb6da309ca1fc972d', 5_000_000);
  const d2 = await recordDeposit('0xt0kenb3ebc05d7523634e5db82701e606b531c7', 12_000_000);
  console.log('[R4] deposit calls:', { d1, d2 });

  console.log('[R4] Economy exercise complete. Verify >1 total in agent_stakes + sponsorship_records visible on dashboard (no hardcodes).');
  console.log('Authority: A = min(R, 100 * sqrt(S_own + S_sponsor/3)) with 4x cap. See authority-math.ts + stake-vault.');
}

main().catch(console.error);
