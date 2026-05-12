/**
 * CC Sprint 9 Phase 6 — Circuit breaker CLI.
 *
 * Usage:
 *   npm run cb:status                       # show all breakers
 *   npm run cb:kill -- <breaker_key>        # flip ON (block traffic)
 *   npm run cb:resume -- <breaker_key>      # flip OFF (allow traffic)
 *
 * Known keys (must match repid_config rows seeded by migration):
 *   cb_disable_x402_settlements
 *   cb_disable_zkp_proofs
 *   cb_disable_onchain_writes
 *   cb_disable_trade_execution
 *   cb_disable_score_writes
 *   cb_freeze_swarm_responses
 *
 * Per RULE-8: this is operator scaffolding. It does NOT auto-flip anything;
 * Sean (or an oncall) runs it explicitly when needed.
 */

import 'dotenv/config';
import { readAllBreakers, flipBreaker, BreakerKey } from '../src/middleware/circuit-breaker';

const VALID_KEYS: BreakerKey[] = [
  'cb_disable_x402_settlements',
  'cb_disable_zkp_proofs',
  'cb_disable_onchain_writes',
  'cb_disable_trade_execution',
  'cb_disable_score_writes',
  'cb_freeze_swarm_responses',
];

(async () => {
  const mode = process.env.CB_MODE ?? process.argv[2];
  const key = process.argv[3] as BreakerKey;

  if (!mode || mode === 'status') {
    const all = await readAllBreakers();
    console.log('CIRCUIT BREAKER STATE');
    console.log('=====================');
    for (const k of VALID_KEYS) {
      const state = all[k] ? '\x1b[31mTRIPPED\x1b[0m' : '\x1b[32mNORMAL\x1b[0m ';
      console.log(`  ${state}  ${k}`);
    }
    return;
  }

  if (mode !== 'kill' && mode !== 'resume') {
    console.error(`Unknown mode: ${mode}. Use status | kill | resume.`);
    process.exit(2);
  }

  if (!key || !VALID_KEYS.includes(key)) {
    console.error(`Specify a known breaker key. Valid keys:\n  ${VALID_KEYS.join('\n  ')}`);
    process.exit(2);
  }

  const on = mode === 'kill';
  await flipBreaker(key, on, 'cli:sprint-9');
  console.log(`${on ? 'TRIPPED' : 'NORMAL'}  ${key}`);
})().catch((e) => { console.error('cb-controls crashed:', e); process.exit(1); });
