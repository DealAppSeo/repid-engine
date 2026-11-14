/**
 * commit-reveal-key.ts — load known-answer work whose answer key was COMMITTED before dispatch and
 * REVEALED after it, for the experimental RepID namespace (src/services/experimental-repid.ts).
 *
 * The conductor (a rehearsal runner) writes each task with
 *   sprint_tag                         the run's tag
 *   metadata.case_id                   the item it asked
 *   metadata.answer_commitment_sha256  sha256("<expected>|<nonce>"), written at insert, before any worker sees it
 * and publishes the same commitments before the first dispatch (their ruler: sha256 of the commitments
 * in item order, joined by "\n"). After the run it reveals EVERY task it dispatched:
 *   { tag, items: [{ n, task_id, case_id, expected, nonce, commitment,
 *                    claimed_by, graded_reply_sha256 }] }
 * where `commitment` is the one it PUBLISHED, and `graded_reply_sha256` / `claimed_by` are the reply and
 * claimer exactly as it graded them (both null when it saw no answer).
 *
 * WHY EVERY REJECTION BLOCKS THE MEASUREMENT. trinity_tasks is an ordinary mutable table and a worker can
 * write its own row; the reveal file is caller-supplied. If any item could quietly drop out, someone who
 * can cause the drop would beat the -(1 + confidence) penalty by removing the items that were wrong. Three
 * reviews found three such doors, each now closed and each a rejection:
 *   - delete or change the stored commitment (Strix):           no_commitment / commitment_changed
 *   - blank or rewrite the result after grading (Grok R2-1):     result_changed / result_not_graded / claimer_changed
 *   - leave the wrong answers out of the reveal file (Grok R2-2): not_revealed, plus the published-commitments hash
 * `revealIsClean` is false when ANY item is rejected, and the reveal command then refuses to report a clean
 * measurement or settle anything. A task the conductor saw NO answer to, and that still has none, is
 * `unanswered`: listed, scored nothing, and not a rejection, because nobody can use it to hide a graded answer.
 *
 * Reads trinity_tasks and repid_agents; writes nothing. The comparison helper is pure.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../db';
import { SCORING_VERSIONS, answerCommitment, knownAnswerEvidence, parseKnownAnswer, type KnownAnswerRow } from './experimental-repid';

export interface RevealItem {
  /** The item's position in the published list (1-based). */
  n: number;
  task_id: string | number; case_id: string; expected: string; nonce: string;
  /** The commitment as PUBLISHED before dispatch (commitments.json / the PR comment), not as read back from the row. */
  commitment: string;
  /** sha256 of trinity_tasks.result exactly as the conductor graded it; null = it saw no answer. */
  graded_reply_sha256: string | null;
  /** trinity_tasks.claimed_by as the conductor graded it; null = it saw no answer. */
  claimed_by: string | null;
}
export interface RevealFile { tag: string; items: RevealItem[] }

export type RevealRejectReason =
  | 'bad_reveal'          // the reveal item itself is malformed
  | 'reveal_mismatch'     // expected|nonce does not open the published commitment
  | 'not_revealed'        // a task dispatched under this tag, with a commitment, is missing from the reveal
  | 'task_not_found'      // no trinity_tasks row with that id
  | 'tag_changed'         // the row no longer carries the run's tag
  | 'case_id_mismatch'    // the row was dispatched for a different item
  | 'no_commitment'       // the row carries no commitment now: removed after dispatch, or never written
  | 'commitment_changed'  // the row's commitment is not the one that was published
  | 'result_changed'      // the row's result is not the reply the conductor graded (rewritten, blanked or removed)
  | 'result_not_graded'   // the row has a result, but the reveal says the conductor graded none
  | 'claimer_changed'     // the row's claimer is not the one the conductor graded
  | 'unknown_agent';      // the claimer is not in repid_agents

export interface RevealRejection { task_id: string; reason: RevealRejectReason }

export interface RevealLoad {
  rows: KnownAnswerRow[];
  rejected: RevealRejection[];
  /** Dispatched, never answered, and still unanswered: scored nothing, and not a rejection. */
  unanswered: string[];
  /** sha256 of the revealed commitments in item order joined by "\n": compare it with the value published before dispatch. */
  published_commitments_sha256: string;
}

/** A reveal is a clean measurement only when NOTHING was rejected (see the header for why). */
export function revealIsClean(rejected: RevealRejection[]): boolean {
  return rejected.length === 0;
}

const KEYS = new Set(['pass', 'veto', 'abstain']);
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The ruler the conductor publishes: the commitments in item order, joined by "\n". */
export function commitmentsRuler(items: Pick<RevealItem, 'n' | 'commitment'>[]): string {
  return sha256([...items].sort((a, b) => a.n - b.n).map((i) => String(i.commitment).toLowerCase()).join('\n'));
}

/** A reveal file is { tag, items }. Throws on anything else. */
export function parseRevealFile(json: unknown): RevealFile {
  const f = json as { tag?: unknown; items?: unknown };
  if (!f || typeof f.tag !== 'string' || f.tag === '' || !Array.isArray(f.items)) {
    throw new Error('reveal file must be { tag, items: [{ n, task_id, case_id, expected, nonce, commitment, claimed_by, graded_reply_sha256 }] }');
  }
  return { tag: f.tag, items: f.items as RevealItem[] };
}

function metadataOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return {};
}

const storedCommitment = (metadata: unknown) => String(metadataOf(metadata).answer_commitment_sha256 ?? '').toLowerCase();

interface TaskRow { id: number | string; claimed_by: string | null; metadata: unknown; result: string | null; sprint_tag: string | null }

export async function loadCommitRevealRows(
  reveal: RevealFile,
  client: Pick<SupabaseClient, 'from'> = db,
): Promise<RevealLoad> {
  const rejected: RevealRejection[] = [];
  const unanswered: string[] = [];
  const valid: (RevealItem & { task_id: string })[] = [];
  const seenN = new Set<number>();
  for (const r of reveal.items) {
    const id = String(r?.task_id ?? '');
    const published = String(r?.commitment ?? '').toLowerCase();
    const graded = r?.graded_reply_sha256 ?? null;
    const claimer = r?.claimed_by ?? null;
    const ok = Number.isInteger(r?.n) && r.n > 0 && !seenN.has(r.n) && /^\d+$/.test(id) &&
      typeof r.case_id === 'string' && r.case_id !== '' && KEYS.has(String(r.expected)) &&
      typeof r.nonce === 'string' && r.nonce !== '' && HEX64.test(published) &&
      (graded === null ? claimer === null : HEX64.test(String(graded)) && typeof claimer === 'string' && claimer !== '');
    if (!ok) { rejected.push({ task_id: id, reason: 'bad_reveal' }); continue; }
    seenN.add(r.n);
    // The conductor's own honesty first: its reveal must open the commitment it published.
    if (answerCommitment(r.expected, r.nonce) !== published) { rejected.push({ task_id: id, reason: 'reveal_mismatch' }); continue; }
    valid.push({ ...r, task_id: id, commitment: published, graded_reply_sha256: graded === null ? null : String(graded).toLowerCase(), claimed_by: claimer });
  }
  const ruler = commitmentsRuler(reveal.items.filter((r) => Number.isInteger(r?.n)));

  // Completeness: every task dispatched under this tag with a commitment must be in the reveal.
  const tagged = await client.from('trinity_tasks').select('id, metadata').eq('sprint_tag', reveal.tag);
  if (tagged.error) throw new Error(`trinity_tasks tag read failed: ${tagged.error.message}`);
  const revealedIds = new Set(reveal.items.map((r) => String(r?.task_id ?? '')));
  for (const t of (tagged.data ?? []) as { id: number | string; metadata: unknown }[]) {
    if (HEX64.test(storedCommitment(t.metadata)) && !revealedIds.has(String(t.id))) rejected.push({ task_id: String(t.id), reason: 'not_revealed' });
  }
  if (!valid.length) return { rows: [], rejected, unanswered, published_commitments_sha256: ruler };

  const ids = [...new Set(valid.map((r) => Number(r.task_id)))];
  const tasks = new Map<string, TaskRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const page = await client.from('trinity_tasks').select('id, claimed_by, metadata, result, sprint_tag').in('id', ids.slice(i, i + 200));
    if (page.error) throw new Error(`trinity_tasks read failed: ${page.error.message}`);
    for (const t of (page.data ?? []) as TaskRow[]) tasks.set(String(t.id), t);
  }

  const names = [...new Set([...tasks.values()].map((t) => t.claimed_by).filter((n): n is string => !!n))];
  const agents = names.length ? await client.from('repid_agents').select('id, agent_id').in('agent_id', names) : { data: [], error: null };
  if (agents.error) throw new Error(`repid_agents read failed: ${agents.error.message}`);
  const uuidOf = new Map((agents.data ?? []).map((a: { id: string; agent_id: string }) => [a.agent_id, a.id]));

  const rows: KnownAnswerRow[] = [];
  for (const r of valid) {
    const task_id = r.task_id;
    const reject = (reason: RevealRejectReason) => rejected.push({ task_id, reason });
    const t = tasks.get(task_id);
    if (!t) { reject('task_not_found'); continue; }
    if (t.sprint_tag !== reveal.tag) { reject('tag_changed'); continue; }
    if (String(metadataOf(t.metadata).case_id ?? '') !== r.case_id) { reject('case_id_mismatch'); continue; }
    // The row must still carry the very commitment that was published.
    const commitment = storedCommitment(t.metadata);
    if (!HEX64.test(commitment)) { reject('no_commitment'); continue; }
    if (commitment !== r.commitment) { reject('commitment_changed'); continue; }
    // And the very reply, and claimer, the conductor graded.
    const hasResult = t.result !== null && t.result !== undefined;
    if (!hasResult) {
      if (r.graded_reply_sha256 !== null) { reject('result_changed'); continue; } // graded, then removed
      unanswered.push(task_id);
      continue;
    }
    if (r.graded_reply_sha256 === null) { reject('result_not_graded'); continue; }
    if (sha256(String(t.result)) !== r.graded_reply_sha256) { reject('result_changed'); continue; }
    if (t.claimed_by !== r.claimed_by) { reject('claimer_changed'); continue; }
    const subject = t.claimed_by ? uuidOf.get(t.claimed_by) : undefined;
    if (!subject || !t.claimed_by) { reject('unknown_agent'); continue; }
    rows.push({ task_id, claimed_by: t.claimed_by, case_id: r.case_id, result: String(t.result), expected: r.expected, subject_agent_id: subject, commitment, nonce: r.nonce });
  }
  return { rows, rejected, unanswered, published_commitments_sha256: ruler };
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
