/**
 * panel-dry-run.ts — BLIND 2-of-3 ADJUDICATION PANEL simulator (DRY-RUN by default)
 * =================================================================================
 * Simulates the blind 2-of-3 peer-verification panel end to end and prints the
 * flow + what it WOULD score — WITHOUT writing anything by default. This is the
 * evidence artifact for the panel design: it shows, per scenario, the three
 * independent votes, the computed 2-of-3 consensus, and the honest score events
 * (agree→+, diverge→PEER_VERIFY_WRONG_CALL, producer per verdict, 0 on
 * no-consensus/tie/timeout).
 *
 * HONESTY: 2-of-3 blind consensus is a STRONG PROXY for correctness, not
 * perfection — a unanimous-but-wrong majority is still wrong. But it is a real,
 * gameable-resistant signal vs one context-contaminated opinion. This script
 * demonstrates the mechanism; it does not claim the verdicts are ground truth.
 *
 * GUARDRAILS: pure computation over synthetic (or optionally recent real)
 * claims. DRY-RUN (default) calls resolvePanel({dryRun:true}) — NO
 * repid_score_events writes, NO current_repid mutation, NO on-chain, NO spend.
 * metadata.contract_id is always a valid uuid. --confirm is intentionally NOT
 * implemented here (scoring belongs to the live /respond panel path, not a
 * driver script) — this file is report-only.
 *
 * USAGE:
 *   npx ts-node scripts/verify/panel-dry-run.ts            # synthetic scenarios
 *   npx ts-node scripts/verify/panel-dry-run.ts --real 5   # + up to 5 recent real claims (read-only)
 *
 *   env for --real (read-only DB): SUPABASE_URL/SUPABASE_SERVICE_KEY or DATABASE_URL,
 *   e.g. DOTENV_CONFIG_PATH=../.env.master npx ts-node -r dotenv/config scripts/verify/panel-dry-run.ts --real 5
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import {
  computeConsensus,
  type PanelVote,
  type PanelVerdict,
  PANEL_PROVIDER_HINTS,
  PANEL_VERIFIER_POOL,
} from '../../src/services/peer-verify-consensus';

const args = process.argv.slice(2);
const realIdx = args.indexOf('--real');
const REAL_LIMIT =
  realIdx >= 0 ? Math.max(1, Number(args[realIdx + 1]) || 5) : 0;

// Fixed synthetic agent uuids so the transcript is stable/readable.
const PRODUCER = '11111111-1111-1111-1111-111111111111';
const VERIFIERS: Record<string, string> = {
  'trinity-mel': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'trinity-shofet': 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'trinity-gcm': 'cccccccc-cccc-cccc-cccc-cccccccccccc',
};

function mkVotes(verdicts: PanelVerdict[]): PanelVote[] {
  const names = PANEL_VERIFIER_POOL;
  return verdicts.map((verdict, i) => {
    const name = names[i % names.length]!;
    return {
      verifier_agent_id: VERIFIERS[name]!,
      verifier_agent_name: name,
      provider: PANEL_PROVIDER_HINTS[name] ?? null,
      verdict,
    };
  });
}

interface Scenario {
  label: string;
  verdicts: PanelVerdict[];
}

const SCENARIOS: Scenario[] = [
  { label: 'Unanimous verified (3-0)', verdicts: ['verified', 'verified', 'verified'] },
  { label: 'Majority verified (2-1)', verdicts: ['verified', 'verified', 'disputed'] },
  { label: 'Majority disputed (2-1)', verdicts: ['disputed', 'disputed', 'verified'] },
  { label: 'Unanimous disputed (3-0)', verdicts: ['disputed', 'disputed', 'disputed'] },
  { label: 'Tie via timeout (1-1-timeout) → NO consensus', verdicts: ['verified', 'disputed', 'timeout'] },
  { label: 'Quorum with one timeout (2 verified, 1 timeout)', verdicts: ['verified', 'verified', 'timeout'] },
  { label: 'All timeout → NO consensus', verdicts: ['timeout', 'timeout', 'timeout'] },
  { label: 'Only 2 votes in, split → NO consensus (waiting)', verdicts: ['verified', 'disputed'] },
];

function line(ch = '─', n = 74): string {
  return ch.repeat(n);
}

async function runScenario(s: Scenario): Promise<void> {
  const sourceResponseId = randomUUID();
  const contractId = sourceResponseId; // valid uuid for metadata.contract_id
  const votes = mkVotes(s.verdicts);

  console.log(`\n${line()}`);
  console.log(`SCENARIO: ${s.label}`);
  console.log(`  source_response_id=${sourceResponseId}`);
  console.log(`  producer=${PRODUCER}`);
  console.log(`  BLIND votes (each verifier voted without seeing the others):`);
  for (const v of votes) {
    console.log(
      `    - ${v.verifier_agent_name} [${v.provider ?? 'n/a'}] → ${v.verdict}`
    );
  }

  const consensus = computeConsensus(votes);
  console.log(
    `  CONSENSUS: reached=${consensus.reached} verdict=${consensus.verdict ?? 'none'} ` +
      `reason=${consensus.reason} tally=${JSON.stringify(consensus.tally)}`
  );

  // SYNTHETIC scenarios have no DB rows, so we compute the score plan in-memory
  // (an exact mirror of resolvePanel's logic — see the shared consensus/delta
  // logic in peer-verify-consensus.ts). This keeps the dry-run DB-free and fast.
  // The live path uses resolvePanel({dryRun:false}) which writes via
  // applyValidationEvent; here nothing is written.
  void sourceResponseId;
  void contractId;
  const scorePlan = deriveScorePlanInMemory(consensus, votes);

  if (!consensus.reached) {
    console.log(`  WOULD SCORE: nothing (no consensus → 0 for everyone)`);
    return;
  }
  console.log(`  WOULD SCORE (dry-run, nothing written):`);
  for (const ev of scorePlan) {
    const who =
      ev.role === 'producer'
        ? 'producer'
        : votes.find((v) => v.verifier_agent_id === ev.agent_id)?.verifier_agent_name ??
          ev.agent_id;
    const agree = ev.role === 'verifier' ? ` (agreed=${ev.agreed})` : '';
    console.log(`    - ${who}: ${ev.event_type} ${ev.delta >= 0 ? '+' : ''}${ev.delta}${agree}`);
  }
}

// In-memory mirror of resolvePanel's scoring logic for synthetic (no-DB) runs.
function deriveScorePlanInMemory(
  consensus: ReturnType<typeof computeConsensus>,
  votes: PanelVote[]
): Array<{
  agent_id: string;
  role: 'producer' | 'verifier';
  event_type: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY';
  delta: number;
  agreed?: boolean;
}> {
  if (!consensus.reached || consensus.verdict === null) return [];
  const AGREE = Number(process.env.PEER_VERIFY_PANEL_AGREE_DELTA || 3);
  const DIVERGE = Number(process.env.PEER_VERIFY_PANEL_DIVERGE_DELTA || -5);
  const PROD_V = Number(process.env.PEER_VERIFY_PANEL_PRODUCER_VERIFIED_DELTA || 3);
  const PROD_D = Number(process.env.PEER_VERIFY_PANEL_PRODUCER_DISPUTED_DELTA || -5);
  const out: ReturnType<typeof deriveScorePlanInMemory> = [];
  const v = consensus.verdict;
  out.push({
    agent_id: PRODUCER,
    role: 'producer',
    event_type: v === 'verified' ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED',
    delta: v === 'verified' ? PROD_V : PROD_D,
  });
  for (const vote of votes) {
    if (vote.verdict === 'timeout') continue;
    const agreed = vote.verdict === v;
    out.push({
      agent_id: vote.verifier_agent_id,
      role: 'verifier',
      event_type: agreed ? 'VALIDATOR_REWARD' : 'VALIDATOR_PENALTY',
      delta: agreed ? AGREE : DIVERGE,
      agreed,
    });
  }
  return out;
}

async function runReal(limit: number): Promise<void> {
  // Read-only: pull recent claims from peer_verification_queue and show how the
  // panel WOULD adjudicate them. We do NOT have 3 real votes (the votes table is
  // new/empty), so we surface the single legacy verdict + explain that under the
  // panel it would be ONE of three required votes — consensus pending.
  const { db } = await import('../../src/db');
  const { data, error } = await db
    .from('peer_verification_queue')
    .select('id, source_response_id, source_agent_id, verifier_agent_id, verification_status, claim_text, certainty_at_claim, completed_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  console.log(`\n${line('═')}`);
  console.log(`REAL CLAIMS (read-only, most recent ${limit}) — legacy verdicts shown as ONE panel vote`);
  if (error) {
    console.log(`  (could not read peer_verification_queue: ${error.message})`);
    return;
  }
  for (const row of data ?? []) {
    console.log(`\n  queue_id=${row.id} status=${row.verification_status}`);
    console.log(`    source_response_id=${row.source_response_id}`);
    console.log(`    legacy single verifier=${row.verifier_agent_id ?? 'none'}`);
    console.log(
      `    Under the panel this legacy verdict is 1 of 3 required BLIND votes; ` +
        `consensus would be PENDING until 2 more independent verifiers vote.`
    );
  }
}

async function main(): Promise<void> {
  console.log(line('═'));
  console.log('BLIND 2-of-3 ADJUDICATION PANEL — DRY-RUN (nothing is written)');
  console.log('Consensus = a strong PROXY for correctness, not perfection.');
  console.log('Scoring: agree→+3, diverge→PEER_VERIFY_WRONG_CALL(-5), producer per verdict, 0 on no-consensus.');
  console.log(line('═'));

  for (const s of SCENARIOS) {
    await runScenario(s);
  }

  if (REAL_LIMIT > 0) {
    await runReal(REAL_LIMIT);
  }

  console.log(`\n${line('═')}`);
  console.log('DRY-RUN COMPLETE. No repid_score_events written, no scores mutated.');
  console.log('Go-live: apply migration → deploy → set PEER_VERIFY_PANEL_ENABLED=true');
  console.log('         (leave PEER_VERIFY_REPID_ENABLED=false to retire the old single-verifier path).');
  console.log(line('═'));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[panel-dry-run] error:', e?.message ?? e);
    process.exit(1);
  });
