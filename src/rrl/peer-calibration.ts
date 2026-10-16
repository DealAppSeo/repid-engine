/**
 * PEER CALIBRATION (shadow) — Lane A, BACKEND_HARDENING_LOOPS 2026-10-16.
 *
 * The protocol:
 *   1. BEFORE it answers, an agent records `self_claim_is` (TRUE / FALSE / UNDETERMINED: what it
 *      believes the claim is) and `self_confidence` (0..1: the probability that its answer will be
 *      judged correct). The record is write-once: it cannot be revised after peers have rated.
 *   2. After it answers, agents from OTHER model families rate the answer: `answer_is` TRUE
 *      (correct), FALSE (wrong) or UNDETERMINED. Peers never see the self-rating.
 *   3. The answer's outcome is RESOLVED only when at least MIN_PEER_FAMILIES distinct other families
 *      gave a determinate rating and all agree. Anything less is UNRESOLVED and is never scored:
 *      an unresolved answer is not "correct" and not "wrong".
 *   4. Calibration per agent and per family: Brier = mean (self_confidence - outcome)^2 over resolved
 *      answers, the overconfidence rate (confident answers judged wrong), and COVERAGE (answered /
 *      presented), because an agent can buy a good Brier by abstaining (SPEC_AMENDMENTS v0.1).
 *
 * SHADOW ONLY (CLAUDE_RULES r23). Nothing here reads or writes RepID, stakes or money. The only
 * writer is DbCalibrationStore, which writes `calibration_shadow_ratings` and does nothing unless
 * CALIBRATION_SHADOW_ENABLED=true. That table does not exist yet: its SQL is review-only
 * (E:\dev\reports\2026-10-16\loops\CALIBRATION_SHADOW_TABLE.sql). A calibration reward needs Sean.
 *
 * NO DEFAULT IS EVER A RATING. A self-confidence that is not a finite number in [0,1], or a claim_is
 * outside the three values, makes the rating unparseable: it is not stored, and the answer is
 * NOT_CHECKED. A provider failure is the same. (The 0.2/0.8 pattern of May 23-27 was a fallback
 * score stored as a vote.)
 */

export type ClaimIs = 'TRUE' | 'FALSE' | 'UNDETERMINED';

export interface SelfRating {
  task_id: string;
  agent_id: string;
  family: string;
  self_claim_is: ClaimIs;
  /** P(this agent's answer will be judged correct), stated before the answer. */
  self_confidence: number;
}

export interface PeerRating {
  task_id: string;
  /** Whose answer is being rated. */
  subject_agent_id: string;
  rater_agent_id: string;
  rater_family: string;
  /** TRUE = the answer is correct, FALSE = it is wrong, UNDETERMINED = the rater could not tell. */
  answer_is: ClaimIs;
}

export const MIN_PEER_FAMILIES = 2;
/** A self-confidence at or above this is "confident" for the overconfidence rate. */
export const CONFIDENT = 0.8;

const CLAIM_IS: readonly ClaimIs[] = ['TRUE', 'FALSE', 'UNDETERMINED'];

/** A claim_is value, or null. Never a default. */
export function parseClaimIs(v: unknown): ClaimIs | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (CLAIM_IS as readonly string[]).includes(s) ? (s as ClaimIs) : null;
}

/** A confidence in [0,1], or null. A number outside the range (a percent, say) is not guessed at. */
export function parseConfidence01(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export type Outcome =
  | { status: 'resolved'; correct: 0 | 1; families: string[] }
  | { status: 'abstained' }
  | { status: 'unresolved'; reason: string };

/** The peer-judged outcome of one self-rated answer. Pure. */
export function resolveOutcome(self: SelfRating, peers: readonly PeerRating[]): Outcome {
  if (self.self_claim_is === 'UNDETERMINED') return { status: 'abstained' };
  const byFamily = new Map<string, Set<ClaimIs>>();
  for (const p of peers) {
    if (p.task_id !== self.task_id || p.subject_agent_id !== self.agent_id) continue;
    // No self-rating and no same-family rating: one model's error must not confirm itself.
    if (p.rater_agent_id === self.agent_id || p.rater_family === self.family) continue;
    if (p.answer_is === 'UNDETERMINED') continue;
    const s = byFamily.get(p.rater_family) ?? new Set<ClaimIs>();
    s.add(p.answer_is);
    byFamily.set(p.rater_family, s);
  }
  // A family that said both is not a determinate rating.
  const determinate = [...byFamily].filter(([, s]) => s.size === 1).map(([f, s]) => ({ family: f, v: [...s][0]! }));
  if (determinate.length < MIN_PEER_FAMILIES) {
    return { status: 'unresolved', reason: `${determinate.length} determinate peer famil${determinate.length === 1 ? 'y' : 'ies'}, need ${MIN_PEER_FAMILIES}` };
  }
  if (new Set(determinate.map((d) => d.v)).size > 1) return { status: 'unresolved', reason: 'peer families disagree' };
  return { status: 'resolved', correct: determinate[0]!.v === 'TRUE' ? 1 : 0, families: determinate.map((d) => d.family) };
}

export interface CalibrationSummary {
  presented: number;
  /** Self-ratings that took a side (TRUE or FALSE). */
  answered: number;
  resolved: number;
  /** answered / presented. A good Brier at low coverage is abstention, not calibration. */
  coverage: number | null;
  /** Mean (self_confidence - outcome)^2 over resolved answers. Lower is better; 0.25 is a coin at 0.5. */
  brier: number | null;
  mean_confidence: number | null;
  /** Share of resolved answers judged correct. */
  accuracy: number | null;
  /** mean_confidence - accuracy. Positive = overconfident. */
  confidence_gap: number | null;
  /** Of resolved answers stated at >= CONFIDENT, the share judged wrong. */
  overconfidence_rate: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Calibration of a set of self-ratings against their peer-judged outcomes. Pure. */
export function summarize(selfs: readonly SelfRating[], peers: readonly PeerRating[]): CalibrationSummary {
  const scored: Array<{ c: number; o: 0 | 1 }> = [];
  let answered = 0;
  for (const s of selfs) {
    if (s.self_claim_is !== 'UNDETERMINED') answered++;
    const o = resolveOutcome(s, peers);
    if (o.status === 'resolved') scored.push({ c: s.self_confidence, o: o.correct });
  }
  const confident = scored.filter((x) => x.c >= CONFIDENT);
  const mc = mean(scored.map((x) => x.c));
  const acc = mean(scored.map((x) => x.o));
  return {
    presented: selfs.length,
    answered,
    resolved: scored.length,
    coverage: selfs.length ? answered / selfs.length : null,
    brier: mean(scored.map((x) => (x.c - x.o) ** 2)),
    mean_confidence: mc,
    accuracy: acc,
    confidence_gap: mc === null || acc === null ? null : mc - acc,
    overconfidence_rate: confident.length ? confident.filter((x) => x.o === 0).length / confident.length : null,
  };
}

/** summarize(), grouped by a key (agent_id, or family). */
export function summarizeBy(
  selfs: readonly SelfRating[],
  peers: readonly PeerRating[],
  key: (s: SelfRating) => string,
): Record<string, CalibrationSummary> {
  const groups = new Map<string, SelfRating[]>();
  for (const s of selfs) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  return Object.fromEntries([...groups].map(([k, g]) => [k, summarize(g, peers)]));
}

// ── Storage: an interface, so the protocol runs (and is tested) without the shadow table. ──────────

export interface CalibrationStore {
  saveSelf(r: SelfRating): Promise<void>;
  savePeer(r: PeerRating): Promise<void>;
}

/** In-process store: tests and the eval harness. Write-once per (task, agent), like the table. */
export class MemoryCalibrationStore implements CalibrationStore {
  readonly selfs: SelfRating[] = [];
  readonly peers: PeerRating[] = [];
  async saveSelf(r: SelfRating): Promise<void> {
    if (this.selfs.some((s) => s.task_id === r.task_id && s.agent_id === r.agent_id)) {
      throw new Error(`self-rating for ${r.agent_id} on ${r.task_id} is write-once`);
    }
    this.selfs.push(r);
  }
  async savePeer(r: PeerRating): Promise<void> {
    this.peers.push(r);
  }
}

export const CALIBRATION_SHADOW_TABLE = 'calibration_shadow_ratings';

/** Default OFF. Only the exact string 'true' arms the shadow writer. */
export function calibrationShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CALIBRATION_SHADOW_ENABLED === 'true';
}

type InsertOnly = { from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error?: unknown }> } };

/**
 * Shadow writer. Writes ONLY `calibration_shadow_ratings`, and nothing at all unless
 * CALIBRATION_SHADOW_ENABLED=true. A failed insert is logged and dropped: shadow telemetry must never
 * break the path it observes.
 */
export class DbCalibrationStore implements CalibrationStore {
  constructor(private readonly db: InsertOnly, private readonly env: NodeJS.ProcessEnv = process.env) {}
  private async insert(row: Record<string, unknown>): Promise<void> {
    if (!calibrationShadowEnabled(this.env)) return;
    const { error } = await this.db.from(CALIBRATION_SHADOW_TABLE).insert(row);
    if (error) console.warn(`[calibration-shadow] insert failed (dropped): ${String((error as { message?: string }).message ?? error)}`);
  }
  saveSelf(r: SelfRating): Promise<void> {
    return this.insert({ kind: 'self', task_id: r.task_id, subject_agent_id: r.agent_id, subject_family: r.family, self_claim_is: r.self_claim_is, self_confidence: r.self_confidence });
  }
  savePeer(r: PeerRating): Promise<void> {
    return this.insert({ kind: 'peer', task_id: r.task_id, subject_agent_id: r.subject_agent_id, rater_agent_id: r.rater_agent_id, rater_family: r.rater_family, answer_is: r.answer_is });
  }
}
