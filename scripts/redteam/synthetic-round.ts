/**
 * S-REDTEAM-R2 Phase 3 gate — synthetic adjudication round.
 *
 * Runs the three asymmetric cases on ISOLATED synthetic agents (redteam-synth-*, started at 600 with
 * floor 500 so penalties have headroom to land and floor-respect is demonstrable), then prints the
 * three deltas and the red_team_results rows for SQL verification:
 *   1 good_catch     → +finder, −subject
 *   1 frivolous_reject → −accuser, subject 0
 *   1 lazy_subject   → −subject (+finder)
 *
 * MEASURE/PROOF only — synthetic agents, not real trinity. Run: ts-node scripts/redteam/synthetic-round.ts
 */
import { db } from '../../src/db';
import { adjudicate } from '../../src/testing/redteam-adjudication';

// Base names; a DB trigger prepends "trinity-", so the STORED name is resolved after insert.
// agent_name has no unique constraint, so ensureAgent deletes any existing rows first (dupe-safe).
const BASE = ['redteam-synth-finder', 'redteam-synth-subject', 'redteam-synth-accuser'];

async function ensureAgent(base: string, idx: number, repid: number): Promise<string> {
  // Clean any prior rows (base or trinity-prefixed) + their events.
  const { data: prior } = await db.from('repid_agents').select('id').ilike('agent_name', `%${base}`);
  for (const p of (prior ?? []) as any[]) await db.from('repid_score_events').delete().eq('agent_id', p.id);
  await db.from('repid_agents').delete().ilike('agent_name', `%${base}`);
  await db.from('repid_agents').insert({
    agent_name: base, erc8004_address: `0x${'00'.repeat(19)}${(idx + 1).toString(16).padStart(2, '0')}`,
    current_repid: repid, peak_repid: repid,
  });
  const { data } = await db.from('repid_agents').select('agent_name').ilike('agent_name', `%${base}`).maybeSingle();
  return (data as any)?.agent_name as string; // the trigger-prefixed stored name
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const [finder, subject, accuser] = await Promise.all(BASE.map((b, i) => ensureAgent(b, i, 600)));
  console.log(`[redteam] synth agents reset to 600 (floor 500): ${finder}, ${subject}, ${accuser}. run=${stamp}`);

  const results = [];
  results.push(await adjudicate({ case: 'good_catch', challenge_id: `synth-good-${stamp}`,
    finder, subject,
    evidence: 'Claim "the contract was audited" has no artifact_url and no audit hash; REJECT upheld.' }));
  results.push(await adjudicate({ case: 'frivolous_reject', challenge_id: `synth-friv-${stamp}`,
    finder: accuser, subject,
    evidence: 'REJECT with no specific evidence; overturned by panel as frivolous.' }));
  results.push(await adjudicate({ case: 'lazy_subject', challenge_id: `synth-lazy-${stamp}`,
    finder, subject,
    artifact_url: 'NO_ARTIFACT_SAVED', substance_passed: false }));

  console.log('\n=== APPLIED DELTAS ===');
  for (const r of results) {
    console.log(`[${r.case}] rt_id=${r.red_team_result_id}`);
    for (const d of r.deltas) console.log(`   ${d.role.padEnd(8)} ${d.agent.padEnd(24)} ${d.delta > 0 ? '+' : ''}${d.delta}  ${d.before}→${d.after}  (${d.event_type})`);
  }

  // Verify via SQL read-back.
  const { data: rtRows } = await db.from('red_team_results').select('id, attack_type, attacker_repid_delta, defender_repid_delta, detected, false_positive').like('challenge_id', `synth-%${stamp}`).order('id');
  console.log(`\n=== red_team_results rows this round: ${(rtRows ?? []).length} ===`);
  for (const r of (rtRows ?? []) as any[]) console.log(`   id=${r.id} ${r.attack_type} att_Δ=${r.attacker_repid_delta} def_Δ=${r.defender_repid_delta} detected=${r.detected} fp=${r.false_positive}`);

  const { data: ev } = await db.from('repid_score_events').select('event_type, delta, metadata').eq('metadata->>source', 'S-REDTEAM-R2').order('id', { ascending: false }).limit(6);
  console.log('\n=== S-REDTEAM-R2 score events (event_type / role / delta) ===');
  for (const e of (ev ?? []) as any[]) console.log(`   ${e.event_type} (${e.metadata?.role}): ${e.delta}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
