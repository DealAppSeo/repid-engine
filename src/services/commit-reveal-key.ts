/**
 * commit-reveal-key.ts — load known-answer work whose answer key was COMMITTED before dispatch and
 * REVEALED after it, for the experimental RepID namespace (src/services/experimental-repid.ts).
 *
 * The conductor (a rehearsal runner) writes each task with
 *   metadata.case_id                   the item it asked
 *   metadata.answer_commitment_sha256  sha256("<expected>|<nonce>"), written at insert, before any worker sees it
 * and publishes the same commitments before the first dispatch. After the run it reveals
 * (task_id, case_id, expected, nonce, commitment) for every task it graded as answered, where
 * `commitment` is the one it PUBLISHED. An item is accepted only when expected|nonce recomputes the
 * published commitment AND the task row still carries that same commitment.
 *
 * WHY EVERY REJECTION BLOCKS THE MEASUREMENT (Strix, #1544). trinity_tasks.metadata is an ordinary
 * mutable column, and a worker can write its own row. If a rejected item simply dropped out, an answerer
 * could delete or change the commitment on items it got wrong and leave the run with a better score than
 * the -(1 + confidence) it earned: an exclusion it can cause would beat the penalty. So a rejection is
 * never a quiet drop. `revealIsClean` is false when ANY item is rejected, and the reveal command then
 * refuses to report a clean measurement or settle anything. The conductor reveals only answered tasks,
 * so even 'not_answered' means the row changed after grading.
 *
 * Reads trinity_tasks and repid_agents; writes nothing. The comparison helper is pure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../db';
import { SCORING_VERSIONS, answerCommitment, knownAnswerEvidence, parseKnownAnswer, type KnownAnswerRow } from './experimental-repid';

export interface RevealItem {
  task_id: string | number; case_id: string; expected: string; nonce: string;
  /** The commitment as PUBLISHED before dispatch (commitments.json / the PR comment), not as read back from the row. */
  commitment: string;
}

export type RevealRejectReason =
  | 'bad_reveal'          // the reveal item itself is malformed, or names no published commitment
  | 'reveal_mismatch'     // expected|nonce does not recompute the published commitment
  | 'task_not_found'      // no trinity_tasks row with that id
  | 'case_id_mismatch'    // the row was dispatched for a different item
  | 'no_commitment'       // the row carries no commitment now: removed after dispatch, or never written
  | 'commitment_changed'  // the row's commitment is not the one that was published
  | 'not_answered'        // no claimer or no result now, though the conductor graded an answer
  | 'unknown_agent';      // the claimer is not in repid_agents

export interface RevealRejection { task_id: string; reason: RevealRejectReason }

/** A reveal is a clean measurement only when NOTHING was rejected (see the header for why). */
export function revealIsClean(rejected: RevealRejection[]): boolean {
  return rejected.length === 0;
}

const KEYS = new Set(['pass', 'veto', 'abstain']);
const HEX64 = /^[0-9a-f]{64}$/;

/** Accepts a bare array or { items: [...] }. Throws on a file that is not either. */
export function parseRevealFile(json: unknown): RevealItem[] {
  const items = Array.isArray(json) ? json : (json as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new Error('reveal file must be an array of {task_id, case_id, expected, nonce, commitment} or {items: [...]}');
  return items as RevealItem[];
}

function metadataOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return {};
}

export async function loadCommitRevealRows(
  reveals: RevealItem[],
  client: Pick<SupabaseClient, 'from'> = db,
): Promise<{ rows: KnownAnswerRow[]; rejected: RevealRejection[] }> {
  const rejected: RevealRejection[] = [];
  const valid: RevealItem[] = [];
  for (const r of reveals) {
    const id = String(r?.task_id ?? '');
    const published = String(r?.commitment ?? '').toLowerCase();
    const ok = /^\d+$/.test(id) && typeof r.case_id === 'string' && r.case_id !== '' &&
      KEYS.has(String(r.expected)) && typeof r.nonce === 'string' && r.nonce !== '' && HEX64.test(published);
    if (!ok) { rejected.push({ task_id: id, reason: 'bad_reveal' }); continue; }
    // The conductor's own honesty first: its reveal must open the commitment it published.
    if (answerCommitment(r.expected, r.nonce) !== published) { rejected.push({ task_id: id, reason: 'reveal_mismatch' }); continue; }
    valid.push({ ...r, task_id: id, commitment: published });
  }
  if (!valid.length) return { rows: [], rejected };

  const ids = [...new Set(valid.map((r) => Number(r.task_id)))];
  const tasks = new Map<string, { claimed_by: string | null; metadata: unknown; result: string | null }>();
  for (let i = 0; i < ids.length; i += 200) {
    const page = await client.from('trinity_tasks').select('id, claimed_by, metadata, result').in('id', ids.slice(i, i + 200));
    if (page.error) throw new Error(`trinity_tasks read failed: ${page.error.message}`);
    for (const t of page.data ?? []) tasks.set(String(t.id), t);
  }

  const names = [...new Set([...tasks.values()].map((t) => t.claimed_by).filter((n): n is string => !!n))];
  const agents = names.length ? await client.from('repid_agents').select('id, agent_id').in('agent_id', names) : { data: [], error: null };
  if (agents.error) throw new Error(`repid_agents read failed: ${agents.error.message}`);
  const uuidOf = new Map((agents.data ?? []).map((a: { id: string; agent_id: string }) => [a.agent_id, a.id]));

  const rows: KnownAnswerRow[] = [];
  for (const r of valid) {
    const task_id = String(r.task_id);
    const t = tasks.get(task_id);
    if (!t) { rejected.push({ task_id, reason: 'task_not_found' }); continue; }
    const md = metadataOf(t.metadata);
    if (String(md.case_id ?? '') !== r.case_id) { rejected.push({ task_id, reason: 'case_id_mismatch' }); continue; }
    // Then the row: it must still carry the very commitment that was published. Either failure is
    // tampering or a broken dispatch, never a neutral drop: it makes the whole reveal unclean.
    const commitment = String(md.answer_commitment_sha256 ?? '').toLowerCase();
    if (!HEX64.test(commitment)) { rejected.push({ task_id, reason: 'no_commitment' }); continue; }
    if (commitment !== r.commitment) { rejected.push({ task_id, reason: 'commitment_changed' }); continue; }
    if (!t.claimed_by || t.result === null || t.result === undefined) { rejected.push({ task_id, reason: 'not_answered' }); continue; }
    const subject = uuidOf.get(t.claimed_by);
    if (!subject) { rejected.push({ task_id, reason: 'unknown_agent' }); continue; }
    rows.push({ task_id, claimed_by: t.claimed_by, case_id: r.case_id, result: String(t.result), expected: r.expected, subject_agent_id: subject, commitment, nonce: r.nonce });
  }
  return { rows, rejected };
}

/** The bridge's own shadow row for a task is keyed `trinity_task_bridge_<id>` (trinity-task-bridge.ts). */
export const bridgeIdempotencyKey = (taskId: string | number) => `trinity_task_bridge_${taskId}`;

/**
 * The bridge's calculated delta per task (what it WOULD have applied), read-only. A task with no
 * bridge row is absent from the map, which the comparison reports as missing, never as zero.
 */
export async function loadBridgeDeltas(taskIds: string[], client: Pick<SupabaseClient, 'from'> = db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < taskIds.length; i += 200) {
    const keys = taskIds.slice(i, i + 200).map(bridgeIdempotencyKey);
    const r = await client.from('repid_score_events').select('idempotency_key, repid_delta_calculated').in('idempotency_key', keys);
    if (r.error) throw new Error(`repid_score_events read failed: ${r.error.message}`);
    for (const e of r.data ?? []) {
      const id = String(e.idempotency_key).replace('trinity_task_bridge_', '');
      // Number(null) is 0: a NULL delta must stay missing, not become "the bridge said zero".
      if (e.repid_delta_calculated === null || e.repid_delta_calculated === undefined) continue;
      const d = Number(e.repid_delta_calculated);
      if (Number.isFinite(d)) out.set(id, d);
    }
  }
  return out;
}

export interface KeyVsBridgeLine {
  task_id: string; agent: string; expected: string; decision: string | null;
  key_delta: number | null; bridge_delta: number | null;
}
type Sign = 'up' | 'down' | 'zero' | 'missing';
const sign = (x: number | null): Sign => (x === null ? 'missing' : x > 0 ? 'up' : x < 0 ? 'down' : 'zero');
type Tally = Record<Sign, number>;
const tally = (): Tally => ({ up: 0, down: 0, zero: 0, missing: 0 });

export interface KeyVsBridgeSummary {
  version: string;
  graded: number;
  /** Right with a definite answer (pass/veto matching the key). */
  right: number;
  /** Right by abstaining where the key says abstain. The precommitted rule pays these 0, by design. */
  right_abstain: number;
  /** Abstained where the key had a definite answer: 0 under the precommitted rule. */
  abstained: number;
  wrong: number;
  not_scorable: number;
  /** Does the KEY-graded delta go up for every definite right answer and down for every wrong one? */
  key_follows_answer: boolean;
  /** Where the bridge's fact-check delta pointed, split by whether the answer was right or wrong. */
  bridge_on_right: Tally; bridge_on_wrong: Tally;
  lines: KeyVsBridgeLine[];
}

/** Pure. Scores each row under `version` and sets it beside the bridge's delta for the same task. */
export function keyVsBridge(rows: KnownAnswerRow[], bridge: Map<string, number>, version = 'ka-v2-precommitted'): KeyVsBridgeSummary {
  const v = SCORING_VERSIONS[version];
  if (!v) throw new Error(`unknown scoring version ${JSON.stringify(version)}`);
  const s: KeyVsBridgeSummary = {
    version, graded: 0, right: 0, right_abstain: 0, abstained: 0, wrong: 0, not_scorable: 0, key_follows_answer: true,
    bridge_on_right: tally(), bridge_on_wrong: tally(), lines: [],
  };
  for (const r of rows) {
    // The same evidence builder and parse settle uses, so the comparison cannot drift from the write path.
    const content = knownAnswerEvidence(r).content;
    const key = v.score(content);
    const decision = parseKnownAnswer(content).decision;
    const b = bridge.has(r.task_id) ? (bridge.get(r.task_id) as number) : null;
    s.lines.push({ task_id: r.task_id, agent: r.claimed_by, expected: r.expected, decision, key_delta: key, bridge_delta: b });
    if (key === null) { s.not_scorable++; continue; }
    s.graded++;
    if (decision === r.expected) {
      s.bridge_on_right[sign(b)]++;
      if (decision === 'abstain') s.right_abstain++;
      else { s.right++; if (!(key > 0)) s.key_follows_answer = false; }
    } else if (decision === 'abstain') {
      s.abstained++;
    } else {
      s.wrong++;
      s.bridge_on_wrong[sign(b)]++;
      if (!(key < 0)) s.key_follows_answer = false;
    }
  }
  return s;
}
