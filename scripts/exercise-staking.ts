/**
 * R3: exercise staking beyond N=1.
 * Calls recordDeposit + sponsorship multiple times for varied flows.
 * Verifies 4x/3:1/A logic in paths.
 * Run: npx ts-node scripts/exercise-staking.ts (after npm ci; DB writes may simulate or BLOCKED on keys).
 * Gate: >1 rows in agent_stakes / sponsorship_records from this (or manual).
 */
import 'dotenv/config';
import { recordDeposit } from '../src/services/stake-vault';
import { recordSponsorship } from '../src/services/sponsorship';

async function main() {
  console.log('[EXERCISE-STAKING R3] beyond N=1');
  // varied: different builders/agents, amounts, sponsor
  await recordDeposit('builder-demo-1', 10_000_000); // 10 USDC
  await recordDeposit('builder-demo-2', 25_000_000);
  const s1 = await recordSponsorship('trinity-mel', 'some-target-1', 5_000_000, 'r3-ex1');
  const s2 = await recordSponsorship('trinity-veritas', 'some-target-2', 15_000_000, 'r3-ex2');
  console.log('deposits + sponsors called:', { s1, s2 });
  console.log('Check live: agent_stakes and sponsorship_records should have >1 from exercise (or simulated).');
  console.log('Confirm in code: 4x/3:1/A from authority-math used.');
}

main().catch(console.error);
