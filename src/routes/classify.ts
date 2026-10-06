/**
 * POST /api/v1/classify — the one label contract every door calls.
 *
 * In:  { text: string, labels: ["pass", "veto", "not-checked"] }
 * Out: { label: "pass" | "veto" | "not-checked", latency_ms, by, voters?, deciders?, votes?, question? }
 *
 *   by       which path produced the label (ClassifyPath below):
 *            'arithmetic'  the whole text is one equation, decided by exact calculation. No model
 *                          was asked.
 *            'votes'       the claim was sent to at least one free voter. The label is their
 *                          agreement (pass / veto) or not-checked.
 *            'skipped'     the text was sent to no voter: empty text, a malformed body, a labels
 *                          list other than the three, too long for the votes, votes switched off,
 *                          or every voter refused before any request (the data-locality boundary,
 *                          no key, cooling after a 429, the per-minute budget, a retired model id).
 *                          Always not-checked.
 *            'deadline'    the route's own deadline cut the answer off. Always not-checked. Votes
 *                          may already have been in flight, so this says nothing about whether the
 *                          text left.
 *   voters   ONLY when by === 'votes': every voter the claim was actually sent to, as short provider
 *            names, the pair first and then any stand-in (free-votes.ts THE FALLBACK), one entry
 *            per voter, so two models on one host appear twice. This is who RECEIVED the text; a
 *            voter here may have given no answer (a 5xx, a timeout) before a stand-in did.
 *   deciders ONLY when by === 'votes': the two voters whose answers made the label, one per slot,
 *            as short provider names. A pass or veto means both deciders gave that verdict; this,
 *            not `voters`, is what a door names when it says who said true or false. Added
 *            2026-10-05 with the pool; a door that does not read it still gets `voters`.
 *   votes    ONLY with `deciders`: what each decider said, in the same order, as
 *            { voter, family, verdict }. voter is the short provider name (as in `deciders`),
 *            family the model family (gpt-oss, qwen, llama, ...: two models on one host are told
 *            apart by it), verdict one of TRUE, FALSE, UNSURE, or NONE for a decider that was sent
 *            the claim and gave no verdict. Names and verdict words only: never the claim, never
 *            the model's prose. Always consistent with the label (a pass is two TRUE, a veto two
 *            FALSE); an answer where it is not loses `votes` rather than its label. Added
 *            2026-10-06 so a door can show "who said what", most of all when the two flatly
 *            disagree and the label is not-checked (Sean and Grok: "both cannot be right").
 *   question ONLY when label === 'not-checked' AND by === 'votes' AND a question parsed: one
 *            line of 10 to 160 characters ending in '?', with no link, address, markdown, HTML
 *            character reference or verdict word (parseQuestion, src/classify/free-votes.ts). It is the one fact or
 *            assumption whose answer would let the voters decide ("Does the host always open a
 *            door with a goat behind it?"). It comes from this API or it does not appear: a door
 *            shows it verbatim or not at all, and never invents one. It never changes the label.
 *            INERT BY DEFAULT: asked only with CLASSIFY_QUESTIONS=on and when BOTH voters answered
 *            UNSURE (not a disagreement, not an error, timeout, 429 or budget refusal), by at most
 *            one extra call to the first of them, through the votes' own boundary, budget,
 *            cooling and egress path, and only if it fits in what is left of the deadline. With
 *            the flag off the response is byte for byte what it was, and the call is never made.
 *            classifyText (the phone bot) never asks: it has nowhere to show the answer.
 *            CLASSIFY_ASSUMPTIONS=on (off by default) adds one sentence to the vote prompt asking
 *            each voter for UNSURE when a claim is true only under an assumption it does not
 *            state, so a famous-answer claim both voters would wrongly agree on reaches not-checked
 *            (and, with CLASSIFY_QUESTIONS=on, a question) instead of a pass.
 *            The qwen voter sends reasoning_effort 'none' unless CLASSIFY_QWEN_REASONING=low (or
 *            medium, high) says otherwise: with its host's default of high, the reasoning used the
 *            whole token cap and the answer came back empty (free-votes.ts qwenReasoning).
 *
 * `by` and `voters` were added 2026-10-05 so a door can name what answered truthfully instead of
 * calling an arithmetic answer a vote. They are additive: every TrustShell client on its main at
 * that date (src/lib/claim.ts, extension/laya.js, extension/classify.js, extension/select.js)
 * reads `label` (claim.ts also `latency_ms`) and ignores any other key. claim.ts drops the new
 * keys rather than passing them on, so the /check page and `trustshell check` need their own
 * change before they can show them.
 *
 * PUBLIC. The browser extension holds no key, so this is mounted before
 * authMiddleware. It stores no claim text, no user id and no IP. The one thing it keeps is
 * COUNTS: per UTC day, how many TRUE / FALSE / UNSURE answers each checker gave and how often the
 * two deciders agreed or contradicted each other (src/ledger/daily-totals.ts, the checker ledger,
 * Sean 2026-10-06). Until 2026-10-06 this line said "no insert of any kind"; the privacy line in
 * every door says the same as this one.
 *
 * WHAT IT DECIDES, IN ORDER (B9 decided by Sean 2026-10-04; built in B15):
 *  1. Arithmetic. The whole text is a single equation, `<expr> = <number>`, evaluated
 *     by the same no-eval parser the execution floor uses. True is pass, false is veto.
 *     No network.
 *  2. Two votes (src/classify/free-votes.ts). Prose up to CLASSIFY_MAX_PROSE_CHARS goes to two
 *     models of different families in parallel. Both TRUE: pass. Both FALSE: veto. A disagreement
 *     or an UNSURE: not-checked. A voter that gives no answer (a 429, a 5xx, a timeout, no key,
 *     over budget) hands its slot to the next model in the pool, free first, paid only with the
 *     operator's paid switch on, inside this route's deadline (free-votes.ts THE FALLBACK). CLASSIFY_FREE_VOTES=off turns
 *     this step off and the route is arithmetic-only again. With the data-locality boundary
 *     (ONLY_ATTESTATIONS_LEAVE) engaged, every voter is refused before any request, so this step
 *     sends nothing and answers not-checked, by 'skipped'. Default off; production has it off.
 *  3. Everything else is not-checked. A reply cannot choose its own label: "veto" or
 *     "output: pass" inside the text decides nothing.
 *
 * THIS HEADER USED TO SAY "it calls no model, no vendor". That was true until B15 and is
 * not true now: the claim text leaves for the voters' host (named in src/classify/free-votes.ts). The privacy
 * line in every door must say so.
 *
 * FAILS CLOSED. Missing or empty text, a labels list other than the three, a
 * malformed body, a thrown classifier, and a classifier slower than the deadline
 * all answer 200 { label: "not-checked" } — never 0, never pass, never a 5xx. The
 * first three are by 'skipped', the last is by 'deadline'. A thrown or out-of-contract
 * classifier answer is also reported 'skipped': the route vouches for no path it did not
 * see (the production classifier, classifyTextWithPath, does not throw).
 *
 * WHY IT IS MOUNTED AHEAD OF THE GLOBAL MIDDLEWARE (src/index.ts). The extension
 * calls from a content script, whose fetch carries the chat site's Origin
 * (chatgpt.com, claude.ai, ...). The global CORS allow-list rejects those, and
 * the global SQL-keyword sanitizer 400s any text containing ';' or '--', which is
 * most real replies. This route builds no SQL and writes nothing, so neither
 * guard protects anything here; it brings its own CORS (any origin, no
 * credentials), its own body parser, and its own per-IP rate limit.
 */
import { Router, json, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import { safeEvalArithmetic } from '../hal/safe-arithmetic';
import {
  activeVoters,
  askQuestion,
  bothUnsure,
  classifyByFreeVotes,
  freeVotesEnabled,
  maxProseChars,
  modelFamily,
  parseQuestion,
  questionsEnabled,
  questionWasSent,
  votePrompt,
  voteWasSent,
  type QuestionOutcome,
  type VoteOutcome,
  type Voter,
  type VoterProvider,
} from '../classify/free-votes';
import { canaryOk, classifyStats, recordLabel, recordQuestion, recordVotes } from '../classify/vote-health';
import { note as noteLedger } from '../ledger/daily-totals';

export type ClassifyLabel = 'pass' | 'veto' | 'not-checked';

export const CLASSIFY_LABELS: readonly ClassifyLabel[] = ['pass', 'veto', 'not-checked'];
export const NOT_CHECKED: ClassifyLabel = 'not-checked';

/** Only short texts are candidates for the arithmetic check; anything longer is prose. */
const MAX_EQUATION_CHARS = 200;
const RHS_NUMBER = /^-?\d{1,3}(,\d{3})*(\.\d+)?$|^-?\d+(\.\d+)?$/;

/**
 * The free local classifier. Pure, synchronous, no I/O.
 * Returns pass or veto only for a verified whole-text equation; otherwise not-checked.
 */
export function classifyLocal(text: string): ClassifyLabel {
  if (typeof text !== 'string') return NOT_CHECKED;
  const trimmed = text.trim().replace(/\.$/, '').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EQUATION_CHARS) return NOT_CHECKED;
  const parts = trimmed.split('=');
  if (parts.length !== 2) return NOT_CHECKED;
  const lhs = (parts[0] ?? '').trim();
  const rhs = (parts[1] ?? '').trim();
  if (!lhs || !RHS_NUMBER.test(rhs)) return NOT_CHECKED;
  // An expression with no operator is a restatement ("4 = 4"), not a claim worth a pass.
  if (!/[-+*/^%×÷]/.test(lhs.replace(/^-/, ''))) return NOT_CHECKED;
  const left = safeEvalArithmetic(lhs);
  const right = safeEvalArithmetic(rhs);
  if (!left.ok || !right.ok || left.value === undefined || right.value === undefined) return NOT_CHECKED;
  const scale = Math.max(1, Math.abs(left.value), Math.abs(right.value));
  return Math.abs(left.value - right.value) <= 1e-9 * scale ? 'pass' : 'veto';
}

/** Which path produced the label. The contract at the top of this file defines each value. */
export type ClassifyPath = 'arithmetic' | 'votes' | 'skipped' | 'deadline';
export const CLASSIFY_PATHS: readonly ClassifyPath[] = ['arithmetic', 'votes', 'skipped', 'deadline'];

/** The label and the path that produced it. 'deadline' is the route's to say, never a classifier's. */
export type ClassifyOutcome =
  | { label: ClassifyLabel; by: 'arithmetic' | 'skipped' }
  | { label: ClassifyLabel; by: 'votes'; voters: VoterProvider[]; deciders?: VoterProvider[]; votes?: VoteReading[]; question?: string };

/** One decider's answer (the contract's `votes`). Names and verdict words only. */
export interface VoteReading {
  voter: string;
  family: string;
  verdict: 'TRUE' | 'FALSE' | 'UNSURE' | 'NONE';
}

/** What the route runs. Anything that is not a well-formed ClassifyOutcome is not-checked. */
export type Classifier = (text: string) => ClassifyOutcome | Promise<ClassifyOutcome>;

export interface ClassifyResult {
  label: ClassifyLabel;
  latency_ms: number;
  by: ClassifyPath;
  /** Present only when by === 'votes'. */
  voters?: string[];
  /** Present only when by === 'votes': the two voters whose answers made the label. */
  deciders?: string[];
  /** Present only with `deciders`: what each of them said, in the same order. */
  votes?: VoteReading[];
  /** Present only when label === 'not-checked', by === 'votes' and a question parsed. */
  question?: string;
}

type Answer = Omit<ClassifyResult, 'latency_ms'>;

/** The timer's answer. A symbol, so no classifier answer can be mistaken for it. */
const DEADLINE: unique symbol = Symbol('deadline');
/** No step decided: nothing was asked, or the route could not see what was. */
const UNDECIDED: Answer = { label: 'not-checked', by: 'skipped' };
/** The early answers (empty text, wrong labels, malformed body): nothing was sent anywhere. */
const SKIPPED_BODY: ClassifyResult = { label: 'not-checked', latency_ms: 0, by: 'skipped' };

function isLabel(value: unknown): value is ClassifyLabel {
  return value === 'pass' || value === 'veto' || value === 'not-checked';
}

/**
 * A classifier's answer as the route will report it, or null when it is out of contract: a bare
 * label (it names no path), an unknown `by`, a 'skipped' that claims a pass or veto, or a 'votes'
 * with no list of voters. A `question` survives only on not-checked by 'votes', and only if it
 * passes parseQuestion again here; anywhere else, or malformed, it is dropped and the answer kept.
 */
function answerOf(value: unknown): Answer | null {
  if (!value || typeof value !== 'object') return null;
  const { label, by, voters, deciders, votes, question } = value as {
    label?: unknown;
    by?: unknown;
    voters?: unknown;
    deciders?: unknown;
    votes?: unknown;
    question?: unknown;
  };
  if (!isLabel(label)) return null;
  if (by === 'arithmetic') return { label, by };
  if (by === 'skipped') return label === NOT_CHECKED ? { label, by } : null;
  if (by !== 'votes') return null;
  if (!Array.isArray(voters) || voters.length === 0 || !voters.every((v) => typeof v === 'string')) return null;
  const answer: Answer = { label, by, voters: [...(voters as string[])] };
  // Exactly two names, or it is dropped: a pass names its two deciders or none.
  if (Array.isArray(deciders) && deciders.length === 2 && deciders.every((d) => typeof d === 'string')) {
    answer.deciders = [...(deciders as string[])];
    const read = votesOf(votes, answer.deciders, label);
    if (read) answer.votes = read;
  }
  const asked = label === NOT_CHECKED ? parseQuestion(question) : null;
  if (asked !== null) answer.question = asked;
  return answer;
}

const VERDICTS: ReadonlySet<string> = new Set(['TRUE', 'FALSE', 'UNSURE', 'NONE']);
const FAMILY = /^[a-z0-9][a-z0-9.-]{0,31}$/;

/**
 * The `votes` a classifier returned, or null when they are missing or out of contract: exactly the
 * two deciders in order, a plain family id, a verdict word, and agreement with the label (pass is
 * TRUE and TRUE, veto is FALSE and FALSE, and not-checked is neither). Out of contract drops the
 * votes, never the label: the label was already checked on its own.
 */
export function votesOf(value: unknown, deciders: readonly string[], label: ClassifyLabel): VoteReading[] | null {
  if (!Array.isArray(value) || value.length !== 2 || deciders.length !== 2) return null;
  const out: VoteReading[] = [];
  for (const [i, v] of value.entries()) {
    if (!v || typeof v !== 'object') return null;
    const { voter, family, verdict } = v as { voter?: unknown; family?: unknown; verdict?: unknown };
    if (voter !== deciders[i] || typeof family !== 'string' || !FAMILY.test(family)) return null;
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null;
    out.push({ voter: deciders[i]!, family, verdict: verdict as VoteReading['verdict'] });
  }
  const [a, b] = [out[0]!.verdict, out[1]!.verdict];
  // S47: one family agreeing is one opinion, so it can only ever be not-checked (free-votes oneFamily).
  const sameFamily = out[0]!.family === out[1]!.family;
  const agreed = !sameFamily && a === b && (a === 'TRUE' || a === 'FALSE') ? (a === 'TRUE' ? 'pass' : 'veto') : NOT_CHECKED;
  return agreed === label ? out : null;
}

/**
 * Runs a classifier under a deadline. A throw or an out-of-contract answer is not-checked by
 * 'skipped'; an answer after the deadline is not-checked by 'deadline'. The elapsed check also
 * covers a synchronous classifier, which a timer alone cannot interrupt.
 */
export async function classifyWithDeadline(
  text: string,
  classifier: Classifier,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): Promise<ClassifyResult> {
  const started = now();
  const finish = (answer: Answer | typeof DEADLINE): ClassifyResult => {
    const latency_ms = Math.max(0, Math.round(now() - started));
    if (answer === DEADLINE || latency_ms > deadlineMs) return { label: NOT_CHECKED, latency_ms, by: 'deadline' };
    // voters only ever rides with 'votes'; question only with 'votes' too (answerOf checked it).
    if (answer.by !== 'votes') return { label: answer.label, latency_ms, by: answer.by };
    const out: ClassifyResult = { label: answer.label, latency_ms, by: 'votes', voters: answer.voters };
    if (answer.deciders !== undefined) out.deciders = answer.deciders;
    if (answer.votes !== undefined) out.votes = answer.votes;
    if (answer.question !== undefined) out.question = answer.question;
    return out;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
    });
    const answer = Promise.resolve().then(() => classifier(text));
    const out: unknown = await Promise.race([answer, timeout]);
    return finish(out === DEADLINE ? DEADLINE : answerOf(out) ?? UNDECIDED);
  } catch {
    return finish(UNDECIDED);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function textOf(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const text = (body as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

/** labels is optional; when present it must be exactly the three, in any order. */
function labelsOk(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const labels = (body as { labels?: unknown }).labels;
  if (labels === undefined) return true;
  if (!Array.isArray(labels) || labels.length !== CLASSIFY_LABELS.length) return false;
  return CLASSIFY_LABELS.every((l) => labels.includes(l));
}

export interface ClassifyRouterOptions {
  classifier?: Classifier;
  deadlineMs?: number;
  /** Requests per IP per window. */
  limit?: number;
  windowMs?: number;
  /** Checks per visitor per UTC day; 0 is off. Defaults to CLASSIFY_DAILY_LIMIT, else 100. */
  dailyLimit?: number;
  /** Clock for the daily cap (tests). */
  now?: () => number;
}

/**
 * THE DAILY CAP (Sean said GO, 2026-10-05). The per-minute limit above stops a burst. It does not
 * stop one visitor, or one script, sending 30 a minute all day: at that rate a single IP spends a
 * voter's free allowance of 1,000 requests a day in about half an hour, and every other user's
 * stamp goes to Not checked. So each visitor (the same IP key the minute limit uses) gets
 * CLASSIFY_DAILY_LIMIT checks per UTC day, default 100. Past that the route answers 429 with
 * label not-checked and when it resets, exactly like the minute limit: a miss is never a pass,
 * and the extension already reads any non-200 as Not checked.
 *
 * WHY 100. The extension checks every reply on its own, so a busy day of chatting can be 100
 * replies; a lower cap would hit the users who like it most. At about $0.0003 a check on paid
 * tiers, 100 a day is at most about $0.03 per visitor. CLASSIFY_DAILY_LIMIT=0 (or off) turns the
 * cap off. Counts are per process and reset at 00:00 UTC or on restart; production runs one
 * replica, so one count per visitor. Only the count is held: an IP key and a number, never text.
 */
export const CLASSIFY_DEFAULT_DAILY_LIMIT = 100;

export function dailyLimitFrom(raw: string | undefined): number {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0') return 0;
  return positiveInt(v, CLASSIFY_DEFAULT_DAILY_LIMIT);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nextUtcMidnight(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function dailyCap(limit: number, now: () => number) {
  let day = '';
  const counts = new Map<string, number>();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (limit <= 0) return next();
    const t = now();
    const today = utcDay(t);
    if (today !== day) {
      // A new day: yesterday's counts go, all at once, so the map never outgrows one day.
      day = today;
      counts.clear();
    }
    const key = ipKeyGenerator(trustedClientIp(req));
    const used = counts.get(key) ?? 0;
    if (used >= limit) {
      const resetsAt = nextUtcMidnight(t);
      res.set('Retry-After', String(Math.max(1, Math.ceil((resetsAt - t) / 1000))));
      res.status(429).json({
        error: 'daily_limit',
        label: NOT_CHECKED,
        limit,
        resets_at: new Date(resetsAt).toISOString(),
      });
      return;
    }
    counts.set(key, used + 1);
    next();
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const CLASSIFY_DEFAULT_LIMIT = 30;
export const CLASSIFY_DEFAULT_WINDOW_MS = 60 * 1000;
/**
 * Time for the whole answer, stand-ins included (free-votes.ts THE FALLBACK). The website and the
 * CLI wait 6000 ms (TrustShell src/lib/claim.ts), so the route answers well before that. The
 * extension waited only 3000 ms when this was 2500; it waits 6000 ms from the release that reads
 * `deciders`. An older extension still shows Not checked past its own 3 seconds, as it did before.
 */
export const CLASSIFY_DEFAULT_DEADLINE_MS = 5000;
/** One voter's own time. A voter that has not answered by then hands its slot on. */
export const CLASSIFY_VOTE_TIMEOUT_MS = 2500;
/**
 * Room left inside the deadline for the route's own work after the votes return, and again after
 * the clarifying question returns.
 */
const VOTE_HEADROOM_MS = 200;
/** Least time worth giving the clarifying question. With less left, there is no question. */
const MIN_QUESTION_MS = 300;

/**
 * The clarifying question, inside what is left of the deadline, or undefined. The caller has
 * already established not-checked by votes with both voters UNSURE. Never throws, never outlives
 * its time box (a host that ignores the abort is raced by a timer), never changes the label.
 */
async function questionWithin(
  claim: string,
  voters: readonly Voter[],
  outcomes: readonly VoteOutcome[],
  remainingMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const timeoutMs = Math.floor(remainingMs - VOTE_HEADROOM_MS);
  if (!(timeoutMs >= MIN_QUESTION_MS)) return undefined;
  // The first voter that answered UNSURE.
  const voter = voters[outcomes.findIndex((o) => o.kind === 'verdict' && o.verdict === 'UNSURE')];
  if (!voter) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), timeoutMs);
    });
    const out: QuestionOutcome | 'late' = await Promise.race([askQuestion(voter, claim, { env, timeoutMs }), late]);
    // 'late': the request was already out (a refusal resolves at once), so it was asked.
    if (out === 'late') {
      recordQuestion('none', 'late');
      return undefined;
    }
    if (!questionWasSent(out)) return undefined;
    if (out.kind === 'question') {
      recordQuestion('given');
      return out.question;
    }
    recordQuestion('none', out.kind === 'none' ? out.miss : out.reason);
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ClassifyTextOptions {
  /**
   * false: never ask the clarifying question, whatever CLASSIFY_QUESTIONS says. For a caller
   * that cannot show one (classifyText), so it spends no request on an answer it would drop.
   */
  question?: boolean;
}

/**
 * Arithmetic first, then the two free votes, and which of them answered. Never throws: every
 * miss is not-checked. This is what the route runs.
 *
 * `by` is 'votes' only when at least one voter was actually sent the claim (voteWasSent); when
 * every voter was refused before a request (boundary, no key, cooling, budget, retired id) the
 * text went nowhere and the answer is by 'skipped'. `voters` lists exactly the voters that were
 * sent the claim, the pair first and then any stand-in; `deciders` names the two whose answers
 * made the label, when both were sent it. `question` is added only with CLASSIFY_QUESTIONS on, a
 * not-checked from BOTH voters answering UNSURE, and enough deadline left (see the contract).
 */
export async function classifyTextWithPath(
  text: string,
  deadlineMs: number = CLASSIFY_DEFAULT_DEADLINE_MS,
  env: NodeJS.ProcessEnv = process.env,
  options: ClassifyTextOptions = {},
): Promise<ClassifyOutcome> {
  const started = performance.now();
  const local = classifyLocal(text);
  if (local !== NOT_CHECKED) {
    recordLabel(local, 'arithmetic');
    return { label: local, by: 'arithmetic' };
  }
  const trimmed = text.trim();
  if (!freeVotesEnabled(env) || !trimmed || trimmed.length > maxProseChars(env)) {
    recordLabel(NOT_CHECKED, 'skipped');
    return { label: NOT_CHECKED, by: 'skipped' };
  }
  const budgetMs = Math.max(100, deadlineMs - VOTE_HEADROOM_MS);
  const timeoutMs = Math.min(CLASSIFY_VOTE_TIMEOUT_MS, budgetMs);
  const voters = activeVoters(env);
  // A stand-in is used only once the canary has seen it answer right (free-votes.ts THE FALLBACK).
  const { label, outcomes, deciders, attempts } = await classifyByFreeVotes(trimmed, {
    env,
    timeoutMs,
    budgetMs,
    voters,
    backupReady: canaryOk,
  });
  recordVotes(
    attempts.map((t) => t.voter),
    attempts.map((t) => t.outcome),
  );
  // Counts only (src/ledger/daily-totals.ts): names and verdict words, never the claim.
  noteLedger({ attempts, deciders, outcomes, prompt: votePrompt(env), env });
  // Everyone the text reached, stand-ins included: the privacy answer to "who received it".
  const asked = attempts.filter((t) => voteWasSent(t.outcome)).map((t) => t.voter);
  if (asked.length === 0) {
    // No vote left the box, so there is no verdict either: combineVotes can only be not-checked.
    recordLabel(NOT_CHECKED, 'skipped');
    return { label: NOT_CHECKED, by: 'skipped' };
  }
  recordLabel(label, 'votes');
  // The deciders are named only when both were sent the claim. A slot that ran out of stand-ins may
  // end on a voter refused before any request, and a door must never say it "asked" that one.
  const answered = deciders.filter((_, i) => voteWasSent(outcomes[i]!)).map((v) => v.provider);
  // What each decider said, beside who they were. Names and verdict words only, never the claim.
  const votes: VoteReading[] = deciders.map((v, i) => {
    const o = outcomes[i]!;
    return { voter: v.provider, family: modelFamily(v.model), verdict: o.kind === 'verdict' ? o.verdict : 'NONE' };
  });
  const answer = {
    label,
    by: 'votes' as const,
    voters: asked.map((v) => v.provider),
    ...(answered.length === 2 ? { deciders: answered, votes } : {}),
  };
  if (options.question === false || label !== NOT_CHECKED || !questionsEnabled(env) || !bothUnsure(outcomes)) {
    return answer;
  }
  const question = await questionWithin(trimmed, deciders, outcomes, deadlineMs - (performance.now() - started), env);
  return question === undefined ? answer : { ...answer, question };
}

/**
 * The label alone, for callers that do not report the path (the phone bot,
 * src/routes/telegram-public.ts). Same decision, same label counters, as classifyTextWithPath. It
 * never asks the clarifying question: the bot has nowhere to show it, so the request is not made.
 */
export async function classifyText(
  text: string,
  deadlineMs: number = CLASSIFY_DEFAULT_DEADLINE_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClassifyLabel> {
  return (await classifyTextWithPath(text, deadlineMs, env, { question: false })).label;
}

export function createClassifyRouter(options: ClassifyRouterOptions = {}): Router {
  const deadlineMs =
    options.deadlineMs ?? positiveInt(process.env['CLASSIFY_DEADLINE_MS'], CLASSIFY_DEFAULT_DEADLINE_MS);
  const classifier: Classifier = options.classifier ?? ((text) => classifyTextWithPath(text, deadlineMs));
  const limiter = rateLimit({
    windowMs: options.windowMs ?? positiveInt(process.env['CLASSIFY_RATE_WINDOW_MS'], CLASSIFY_DEFAULT_WINDOW_MS),
    max: options.limit ?? positiveInt(process.env['CLASSIFY_RATE_LIMIT'], CLASSIFY_DEFAULT_LIMIT),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
    message: { error: 'too_many_requests', label: NOT_CHECKED },
  });
  const capPerDay = dailyCap(
    options.dailyLimit ?? dailyLimitFrom(process.env['CLASSIFY_DAILY_LIMIT']),
    options.now ?? Date.now,
  );
  const corsAny = cors({
    origin: '*',
    credentials: false,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });

  const corsGet = cors({ origin: '*', credentials: false, methods: ['GET'] });

  const router = Router();
  // B16: keyless health of the check itself. Counts only, never text, per process.
  router.get('/classify/stats', corsGet, (_req: Request, res: Response): void => {
    res.set('Cache-Control', 'no-store').status(200).json(classifyStats());
  });
  router.options('/classify', corsAny);
  router.post(
    '/classify',
    corsAny,
    limiter,
    capPerDay,
    json({ limit: '64kb' }),
    async (req: Request, res: Response): Promise<void> => {
      const body: unknown = req.body;
      const text = textOf(body);
      if (!labelsOk(body) || text.trim().length === 0) {
        res.status(200).json(SKIPPED_BODY);
        return;
      }
      res.status(200).json(await classifyWithDeadline(text, classifier, deadlineMs));
    },
  );
  // A malformed or oversized body is not-checked, not a 4xx/5xx the caller has to interpret.
  router.use('/classify', (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) return next(err);
    res.status(200).json(SKIPPED_BODY);
  });
  return router;
}

export default createClassifyRouter();
