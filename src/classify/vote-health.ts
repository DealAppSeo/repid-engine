/**
 * B16 — the classify route watches itself: counters, per-voter health and a daily canary.
 *
 * WHY. A free host can retire a model, run out of quota, or start answering prose instead of a
 * verdict word. Each of those turns every answer into not-checked, which is honest but silent:
 * the route keeps answering 200 and nobody notices that it has stopped checking anything. That is
 * the shape of the 12-day Groq-retirement outage in repid-engine's CLAUDE.md. This module makes
 * the decay visible from outside, on a keyless URL, so a heartbeat or a person can see it.
 *
 * WHAT IT HOLDS. Counts only: labels, abstain reasons, per-voter verdicts, the canary result,
 * and (with CLASSIFY_QUESTIONS on) how many clarifying questions were asked, given or came back
 * none. Never claim text, never question text, never a user id, never an IP. In memory, per
 * process: a restart zeroes it, and `since` says when that happened, so a zero is never mistaken
 * for "nothing went wrong".
 *
 * THE CANARY. Once a day (and once shortly after boot), each voter is asked one claim that is
 * true and one that is false. A voter that gets either wrong, or does not answer, is reported
 * `degraded` with the reason. It is NOT removed from the vote: the agreement rule already turns
 * a bad voter into not-checked, and silently swapping voters would change what a pass means
 * without anyone deciding it. CLASSIFY_CANARY=off turns the canary off.
 */
import type { VoteLabel, VoteOutcome, Voter } from './free-votes';
import { activeVoters, castVote, questionsEnabled } from './free-votes';

interface VoterHealth {
  voter: string;
  verdicts: { TRUE: number; FALSE: number; UNSURE: number };
  abstains: Record<string, number>;
  /** Unparseable answers by shape (free-votes.ts unparseableShape). Counts only, never text. */
  unparseable_shapes: Record<string, number>;
  canary: { status: 'ok' | 'degraded' | 'not-checked'; reason: string | null; at: string | null };
}

const since = new Date().toISOString();
const labels: Record<VoteLabel | 'arithmetic', number> = {
  pass: 0,
  veto: 0,
  'not-checked': 0,
  arithmetic: 0,
};
const voters = new Map<string, VoterHealth>();

function keyOf(v: Voter): string {
  return `${v.provider}:${v.model}`;
}

function healthOf(v: Voter): VoterHealth {
  const k = keyOf(v);
  let h = voters.get(k);
  if (!h) {
    h = {
      voter: k,
      verdicts: { TRUE: 0, FALSE: 0, UNSURE: 0 },
      abstains: {},
      unparseable_shapes: {},
      canary: { status: 'not-checked', reason: null, at: null },
    };
    voters.set(k, h);
  }
  return h;
}

/**
 * Records one answered request. `decidedBy` is the same `by` the route answers (src/routes/classify.ts
 * ClassifyPath, minus 'deadline', which only the route can see). Only 'arithmetic' has its own
 * counter; 'votes' and 'skipped' are counted by label alone. A deadline cut is NOT seen here: this
 * records the classifier's label even when the route then answered not-checked for lateness.
 */
export function recordLabel(label: VoteLabel, decidedBy: 'arithmetic' | 'votes' | 'skipped'): void {
  labels[label] += 1;
  if (decidedBy === 'arithmetic') labels.arithmetic += 1;
}

/**
 * Clarifying questions (src/classify/free-votes.ts, THE CLARIFYING QUESTION). `asked` counts calls
 * that put the claim on the wire; each ends `given` (a question parsed and went back with the
 * label) or `none` (NONE, a reply that failed the parse, a timeout, a 429 or an HTTP error), so
 * asked === given + none. A call refused before any request (boundary, cooling, budget, too little
 * time left) is not asked and is not counted. Like recordLabel, a later deadline cut by the route
 * is not seen here. No text: the counts are all this holds.
 */
const questions = { asked: 0, given: 0, none: 0 };

export function recordQuestion(outcome: 'given' | 'none'): void {
  questions.asked += 1;
  questions[outcome] += 1;
}

export function recordVotes(vs: readonly Voter[], outcomes: readonly VoteOutcome[]): void {
  vs.forEach((v, i) => {
    const o = outcomes[i];
    if (!o) return;
    const h = healthOf(v);
    if (o.kind === 'verdict') h.verdicts[o.verdict] += 1;
    else {
      h.abstains[o.reason] = (h.abstains[o.reason] ?? 0) + 1;
      if (o.reason === 'unparseable' && o.shape) {
        h.unparseable_shapes[o.shape] = (h.unparseable_shapes[o.shape] ?? 0) + 1;
      }
    }
  });
}

export const CANARY_TRUE = 'Water is made of hydrogen and oxygen.';
export const CANARY_FALSE = 'The Sun orbits the Earth.';

export function canaryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CLASSIFY_CANARY ?? '').trim().toLowerCase() !== 'off';
}

/** Asks each voter the two canary claims and records ok / degraded. Never throws. */
export async function runCanary(
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; fetchImpl?: Parameters<typeof castVote>[2]['fetchImpl'] } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const vs = activeVoters(env);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  await Promise.all(
    vs.map(async (v) => {
      const h = healthOf(v);
      const at = new Date().toISOString();
      try {
        const t = await castVote(v, CANARY_TRUE, { env, timeoutMs, fetchImpl: opts.fetchImpl });
        const f = await castVote(v, CANARY_FALSE, { env, timeoutMs, fetchImpl: opts.fetchImpl });
        const miss = [t, f].find((o) => o.kind === 'abstain');
        if (miss && miss.kind === 'abstain') {
          // No key, or the data-locality boundary refused the call: the voter was never asked, so
          // its health is unknown (not-checked), not bad (degraded).
          const unasked = miss.reason === 'no_key' || miss.reason === 'boundary';
          h.canary = { status: unasked ? 'not-checked' : 'degraded', reason: miss.reason, at };
        } else if (t.kind === 'verdict' && f.kind === 'verdict' && t.verdict === 'TRUE' && f.verdict === 'FALSE') {
          h.canary = { status: 'ok', reason: null, at };
        } else {
          h.canary = { status: 'degraded', reason: 'wrong_answer', at };
        }
      } catch {
        h.canary = { status: 'degraded', reason: 'threw', at };
      }
    }),
  );
}

export interface ClassifyStats {
  since: string;
  per_process: true;
  labels: Record<VoteLabel | 'arithmetic', number>;
  total: number;
  /** not-checked / total, or null when there were no requests (a 0 here would claim success). */
  skip_rate: number | null;
  voters: VoterHealth[];
  /**
   * Present only while CLASSIFY_QUESTIONS is on, so the off shape is today's byte for byte and an
   * absent key says "the feature is off" rather than a zero that reads as "asked none".
   */
  questions?: { asked: number; given: number; none: number };
}

export function classifyStats(env: NodeJS.ProcessEnv = process.env): ClassifyStats {
  for (const v of activeVoters(env)) healthOf(v);
  const total = labels.pass + labels.veto + labels['not-checked'];
  const stats: ClassifyStats = {
    since,
    per_process: true,
    labels: { ...labels },
    total,
    skip_rate: total === 0 ? null : Math.round((labels['not-checked'] / total) * 1000) / 1000,
    voters: [...voters.values()].map((h) => ({
      ...h,
      verdicts: { ...h.verdicts },
      abstains: { ...h.abstains },
      unparseable_shapes: { ...h.unparseable_shapes },
      canary: { ...h.canary },
    })),
  };
  if (questionsEnabled(env)) stats.questions = { ...questions };
  return stats;
}

/** Test hook. */
export function __resetClassifyStats(): void {
  labels.pass = 0;
  labels.veto = 0;
  labels['not-checked'] = 0;
  labels.arithmetic = 0;
  questions.asked = 0;
  questions.given = 0;
  questions.none = 0;
  voters.clear();
}

let canaryTimer: ReturnType<typeof setInterval> | undefined;

/** Starts the daily canary (first run after `firstDelayMs`). Idempotent; timers are unref'd. */
export function startClassifyCanary(firstDelayMs = 60_000, everyMs = 24 * 60 * 60 * 1000): void {
  if (canaryTimer || !canaryEnabled()) return;
  // L0 emergency halt: a halted process makes no outbound calls, the canary included.
  // Loaded lazily so importing the route never pulls in the database client.
  const tick = async (): Promise<void> => {
    try {
      const { shouldParkForHalt } = await import('../services/emergency-halt.js');
      const { db } = await import('../db.js');
      if (await shouldParkForHalt(db, 'classifyCanary')) return;
      await runCanary();
    } catch {
      // The canary is advisory; a failure here must never reach the request path.
    }
  };
  const first = setTimeout(() => void tick(), firstDelayMs);
  first.unref?.();
  canaryTimer = setInterval(() => void tick(), everyMs);
  canaryTimer.unref?.();
}
