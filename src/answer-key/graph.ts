/**
 * The answer key's graph, as pure functions (S46). The tables mirror these rules
 * (supabase/migrations/20261006160000_answer_key_graph.sql); these are what the tests pin.
 *
 * SHAPE. Claims on one side, records on the other, and every CHECK an edge between them. It is
 * bipartite, so support can never loop through it. The only other link is `supersedes`: a later
 * check replacing an earlier one about the same claim. That link must point strictly back in time
 * at a check of the same claim, so the history is a DAG by construction, and a cycle is refused.
 *
 * NOTHING IS DELETED. A Caught does not remove a claim, and a later source does not erase an earlier
 * one: it appends a check that supersedes it. An unchecked check is kept and stays unchecked, so an
 * abstain is never recorded as a lie or as a pass.
 *
 * STATUS OF A CLAIM, from its CURRENT checks only (those nothing supersedes):
 *   supported     at least one current check supports it, and none contradicts it
 *   contradicted  at least one contradicts it, and none supports it
 *   conflicted    current checks disagree: both are shown, neither wins
 *   unchecked     nothing current decides it
 */
import type { AnswerOutcome } from './types';

export interface CheckRow {
  id: string;
  claimId: string;
  checker: string;
  outcome: AnswerOutcome;
  /** The record that was read, by locator. Absent when nothing could be read. */
  recordLocator?: string;
  checkedAt: string;
  supersedes?: string;
}

export type ClaimStatus = 'supported' | 'contradicted' | 'conflicted' | 'unchecked';

export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

/**
 * Refuse a history that is not a DAG of the allowed shape. Throws GraphError naming the bad row.
 * A supersedes link must point at an existing check, of the same claim, strictly earlier.
 */
export function assertHistory(rows: readonly CheckRow[]): void {
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (byId.size !== rows.length) throw new GraphError('two checks share one id');
  const superseded = new Set<string>();
  for (const r of rows) {
    if (!r.supersedes) continue;
    const prior = byId.get(r.supersedes);
    if (!prior) throw new GraphError(`check ${r.id} supersedes ${r.supersedes}, which does not exist`);
    if (prior.claimId !== r.claimId) throw new GraphError(`check ${r.id} supersedes a check about another claim`);
    if (!(Date.parse(prior.checkedAt) < Date.parse(r.checkedAt))) {
      throw new GraphError(`check ${r.id} supersedes ${prior.id}, which is not earlier: that would allow a cycle`);
    }
    if (superseded.has(prior.id)) throw new GraphError(`check ${prior.id} is superseded twice: history must not fork`);
    superseded.add(prior.id);
  }
}

/** The checks nothing supersedes, for each claim. */
export function currentChecks(rows: readonly CheckRow[]): CheckRow[] {
  assertHistory(rows);
  const superseded = new Set(rows.flatMap((r) => (r.supersedes ? [r.supersedes] : [])));
  return rows.filter((r) => !superseded.has(r.id));
}

export function statusOf(current: readonly CheckRow[]): ClaimStatus {
  const supports = current.some((r) => r.outcome === 'supports');
  const contradicts = current.some((r) => r.outcome === 'contradicts');
  if (supports && contradicts) return 'conflicted';
  if (supports) return 'supported';
  if (contradicts) return 'contradicted';
  return 'unchecked';
}

/** Status per claim id, from the whole history. */
export function claimStatuses(rows: readonly CheckRow[]): Map<string, ClaimStatus> {
  const current = currentChecks(rows);
  const byClaim = new Map<string, CheckRow[]>();
  for (const r of current) byClaim.set(r.claimId, [...(byClaim.get(r.claimId) ?? []), r]);
  const out = new Map<string, ClaimStatus>();
  for (const id of new Set(rows.map((r) => r.claimId))) out.set(id, statusOf(byClaim.get(id) ?? []));
  return out;
}

/**
 * Counts over a stated window, never a bare rate: a reader always sees how many, of how many, and
 * when. Below `floor` decided claims there is no rate at all (the ledger's DISPLAY_FLOOR rule).
 */
export function summarize(statuses: Iterable<ClaimStatus>, window: { from: string; to: string }, floor = 100) {
  const counts: Record<ClaimStatus, number> = { supported: 0, contradicted: 0, conflicted: 0, unchecked: 0 };
  for (const s of statuses) counts[s] += 1;
  const total = counts.supported + counts.contradicted + counts.conflicted + counts.unchecked;
  const decided = counts.supported + counts.contradicted;
  return { window, total, counts, decided, decidedShare: decided >= floor && total > 0 ? decided / total : null };
}
