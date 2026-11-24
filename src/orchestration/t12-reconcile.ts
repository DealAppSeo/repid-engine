/**
 * One card's state, read from the canonical tables and kept as four separate answers:
 *
 *   queue       where the row is in the queue (its status and lease)
 *   delivery    whether the deliverable is there (reply, saved artifacts, and whether they agree)
 *   acceptance  whether an independent reviewer passed it
 *   scoring     what the score events did (nothing, shadow only, or moved a live score)
 *
 * They are separate because each has been wrong while another was right: a row stored `done` with
 * no deliverable, a deliverable saved while the reply said only "saved", a reply and its own
 * artifact that disagreed, and a passed check that must still move no live score while in shadow.
 *
 * Pure: it takes rows already read (trinity_tasks, trinity_artifacts, repid_score_events) and
 * writes nothing. Evidence that could not be read is NOT_CHECKED, never a pass and never a fail.
 * When a reply and an artifact disagree, both are kept and the card is routed for review.
 *
 * Caller: t12-rehearsal.ts (scripts/t12/rehearse.ts). No lane stage calls this yet.
 */
import { deliveryReport, type DeliveryReport } from './t12-delivery-check';
import type { DeliveryContract } from './t12-feed-order';

export interface TaskEvidence {
  id: string | number;
  status: string | null;
  claimed_by: string | null;
  /** Lease end. null when the row holds no lease. */
  expires_at: string | null;
  result: string | null;
  /** The model that answered, as the runtime recorded it (metadata.model_used). */
  model: string | null;
}

export interface ReviewEvidence extends TaskEvidence {
  /** pass or fail as the scorer read it; null when the review could not be read. */
  verdict: 'pass' | 'fail' | null;
}

export interface CardEvidence {
  card: string;
  /** The time the rows were read. Leases are compared against it. */
  now: string;
  maker: TaskEvidence;
  /** null: the artifact read failed. An empty list means it succeeded and found none. */
  artifacts: ReadonlyArray<{ id: string | number; content: string | null }> | null;
  contract: DeliveryContract | null;
  reviews: readonly ReviewEvidence[];
  /** null: the score-event read failed. */
  scoreEvents: ReadonlyArray<{ id: string | number; delta: number | null; is_shadow: boolean | null }> | null;
}

export type Queue = 'waiting' | 'in_progress' | 'lease_expired' | 'finished' | 'not_checked';
export type Delivery = 'delivered' | 'not_delivered' | 'disagree' | 'not_checked';
export type Acceptance = 'accepted' | 'rejected' | 'needs_review' | 'pending' | 'not_checked';
export type Scoring = 'none' | 'shadow_only' | 'live_moved' | 'not_checked';
export type Route = 'close' | 'repair' | 'review' | 'wait' | 'not_checked';

export interface CardState {
  card: string;
  task_ids: { maker: string; reviews: string[]; artifacts: string[] };
  queue: Queue;
  delivery: Delivery;
  acceptance: Acceptance;
  scoring: Scoring;
  route: Route;
  reasons: string[];
  /** Every copy as it was judged, so a disagreement keeps both sides. */
  copies: DeliveryReport;
}

const WAITING = ['pending', 'todo', 'assigned'];
const WORKING = ['claimed', 'doing', 'in_progress', 'pending_validation'];

function queueOf(t: TaskEvidence, now: number): Queue {
  if (!t.status || Number.isNaN(now)) return 'not_checked';
  if (WAITING.includes(t.status)) return 'waiting';
  if (!WORKING.includes(t.status)) return 'finished';
  if (!t.expires_at) return 'in_progress';
  const end = Date.parse(t.expires_at);
  return Number.isNaN(end) ? 'not_checked' : end < now ? 'lease_expired' : 'in_progress';
}

/**
 * The model family behind a model id: `nvidia/nemotron-3-ultra:free` and `nemotron-70b` are both
 * `nemotron`; `openai/gpt-oss-120b` is `gpt-oss`.
 * ponytail: the name up to its first digit. Two families that share a prefix would read as one,
 * which errs toward "not independent". Replace with a table if a real pair collides.
 */
export function modelFamily(model: string | null | undefined): string | null {
  const name = (String(model ?? '').toLowerCase().split('/').pop() ?? '').split(':')[0] ?? '';
  const family = name.replace(/[-_. ]*\d.*$/, '');
  return family || null;
}

export function reconcileCard(e: CardEvidence): CardState {
  const reasons: string[] = [];
  const now = Date.parse(e.now);
  const queue = queueOf(e.maker, now);
  if (queue === 'lease_expired') reasons.push(`the maker's lease ended at ${e.maker.expires_at} and the row is still ${e.maker.status}`);
  if (queue === 'not_checked') reasons.push('the row status or the read time could not be read');

  const copies = deliveryReport({ taskId: e.maker.id, status: e.maker.status, reply: e.maker.result, artifacts: e.artifacts ?? [], contract: e.contract });
  let delivery: Delivery;
  if (copies.disagree) {
    delivery = 'disagree';
    reasons.push(`${copies.verdict}; both copies are kept`);
  } else if (copies.delivered_in_reply || copies.delivered_in_artifact) delivery = 'delivered';
  else if (e.artifacts === null) {
    delivery = 'not_checked';
    reasons.push('the artifacts could not be read, and the reply alone does not meet the contract');
  } else if (copies.delivered_in_reply === false && copies.delivered_in_artifact === false) delivery = 'not_delivered';
  else {
    delivery = 'not_checked';
    reasons.push(copies.verdict);
  }

  const makerFamily = modelFamily(e.maker.model);
  const votes = e.reviews.map((r) => {
    const family = modelFamily(r.model);
    if (r.claimed_by && r.claimed_by === e.maker.claimed_by) return { r, counts: false, why: `review ${r.id} is by the maker itself` };
    if (!family || !makerFamily) return { r, counts: false, why: `review ${r.id}: a model family is not recorded, so independence is not shown` };
    if (family === makerFamily) return { r, counts: false, why: `review ${r.id} ran on ${family}, the maker's own model family` };
    if (r.verdict === null) return { r, counts: false, why: `review ${r.id} could not be read` };
    return { r, counts: true, why: '' };
  });
  for (const v of votes) if (!v.counts) reasons.push(v.why);
  const counted = votes.filter((v) => v.counts).map((v) => v.r);
  let acceptance: Acceptance;
  if (delivery === 'disagree') acceptance = 'needs_review';
  else if (counted.some((r) => r.verdict === 'fail')) acceptance = 'rejected';
  else if (counted.some((r) => r.verdict === 'pass')) acceptance = 'accepted';
  else acceptance = e.reviews.length === 0 ? 'pending' : 'not_checked';

  let scoring: Scoring;
  if (e.scoreEvents === null) {
    scoring = 'not_checked';
    reasons.push('the score events could not be read');
  } else if (e.scoreEvents.length === 0) scoring = 'none';
  else if (e.scoreEvents.some((s) => s.delta === null || s.is_shadow === null)) {
    scoring = 'not_checked';
    reasons.push('a score event has no delta or no shadow flag');
  } else if (e.scoreEvents.some((s) => s.delta !== 0 && !s.is_shadow)) {
    scoring = 'live_moved';
    reasons.push('a score event moved a live score');
  } else scoring = 'shadow_only';

  const route: Route =
    delivery === 'disagree' || scoring === 'live_moved' ? 'review'
    : queue === 'waiting' || queue === 'in_progress' ? 'wait'
    : queue === 'lease_expired' || delivery === 'not_delivered' || acceptance === 'rejected' ? 'repair'
    : queue === 'not_checked' || delivery === 'not_checked' || acceptance === 'not_checked' || scoring === 'not_checked' ? 'not_checked'
    : acceptance === 'pending' ? 'wait'
    : 'close';

  return {
    card: e.card,
    task_ids: { maker: String(e.maker.id), reviews: e.reviews.map((r) => String(r.id)), artifacts: (e.artifacts ?? []).map((a) => String(a.id)) },
    queue, delivery, acceptance, scoring, route, reasons, copies,
  };
}
