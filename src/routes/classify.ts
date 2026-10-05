/**
 * POST /api/v1/classify — the one label contract every door calls.
 *
 * In:  { text: string, labels: ["pass", "veto", "not-checked"] }
 * Out: { label: "pass" | "veto" | "not-checked", latency_ms, by, voters?, question? }
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
 *   voters   ONLY when by === 'votes': the voters the claim was actually sent to, as short provider
 *            names in the configured order (activeVoters / CLASSIFY_VOTERS), one entry per voter,
 *            so two models on one host appear twice. Derived from the configuration in use, never
 *            a fixed list. A pass or veto means every voter listed gave that same verdict.
 *   question ONLY when label === 'not-checked' AND by === 'votes' AND a question parsed: one
 *            line of 10 to 160 characters ending in '?', with no link, address, markdown or
 *            verdict word (parseQuestion, src/classify/free-votes.ts). It is the one fact or
 *            assumption whose answer would let the voters decide ("Does the host always open a
 *            door with a goat behind it?"). It comes from this API or it does not appear: a door
 *            shows it verbatim or not at all, and never invents one. It never changes the label.
 *            INERT BY DEFAULT: asked only with CLASSIFY_QUESTIONS=on and when BOTH voters answered
 *            UNSURE (not a disagreement, not an error, timeout, 429 or budget refusal), by at most
 *            one extra call to the first of them, through the votes' own boundary, budget,
 *            cooling and egress path, and only if it fits in what is left of the deadline. With
 *            the flag off the response is byte for byte what it was, and the call is never made.
 *            classifyText (the phone bot) never asks: it has nowhere to show the answer.
 *
 * `by` and `voters` were added 2026-10-05 so a door can name what answered truthfully instead of
 * calling an arithmetic answer a vote. They are additive: every TrustShell client on its main at
 * that date (src/lib/claim.ts, extension/laya.js, extension/classify.js, extension/select.js)
 * reads `label` (claim.ts also `latency_ms`) and ignores any other key. claim.ts drops the new
 * keys rather than passing them on, so the /check page and `trustshell check` need their own
 * change before they can show them.
 *
 * PUBLIC. The browser extension holds no key, so this is mounted before
 * authMiddleware. It stores nothing: no claim text, no user id, no insert of any kind.
 *
 * WHAT IT DECIDES, IN ORDER (B9 decided by Sean 2026-10-04; built in B15):
 *  1. Arithmetic. The whole text is a single equation, `<expr> = <number>`, evaluated
 *     by the same no-eval parser the execution floor uses. True is pass, false is veto.
 *     No network.
 *  2. Two free votes (src/classify/free-votes.ts). Prose up to CLASSIFY_MAX_PROSE_CHARS
 *     goes to two free models in parallel. Both TRUE: pass. Both FALSE: veto. Anything
 *     else, including a 429, a timeout, a missing key or a disagreement: not-checked.
 *     Never a paid model, never a fall-through after a 429. CLASSIFY_FREE_VOTES=off turns
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
  parseQuestion,
  questionsEnabled,
  questionWasSent,
  voteWasSent,
  type QuestionOutcome,
  type VoteOutcome,
  type Voter,
  type VoterProvider,
} from '../classify/free-votes';
import { classifyStats, recordLabel, recordQuestion, recordVotes } from '../classify/vote-health';

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
  | { label: ClassifyLabel; by: 'votes'; voters: VoterProvider[]; question?: string };

/** What the route runs. Anything that is not a well-formed ClassifyOutcome is not-checked. */
export type Classifier = (text: string) => ClassifyOutcome | Promise<ClassifyOutcome>;

export interface ClassifyResult {
  label: ClassifyLabel;
  latency_ms: number;
  by: ClassifyPath;
  /** Present only when by === 'votes'. */
  voters?: string[];
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
  const { label, by, voters, question } = value as { label?: unknown; by?: unknown; voters?: unknown; question?: unknown };
  if (!isLabel(label)) return null;
  if (by === 'arithmetic') return { label, by };
  if (by === 'skipped') return label === NOT_CHECKED ? { label, by } : null;
  if (by !== 'votes') return null;
  if (!Array.isArray(voters) || voters.length === 0 || !voters.every((v) => typeof v === 'string')) return null;
  const answer: Answer = { label, by, voters: [...(voters as string[])] };
  const asked = label === NOT_CHECKED ? parseQuestion(question) : null;
  if (asked !== null) answer.question = asked;
  return answer;
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
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const CLASSIFY_DEFAULT_LIMIT = 30;
export const CLASSIFY_DEFAULT_WINDOW_MS = 60 * 1000;
/** The stamp gives up at 3000 ms (extension/laya.js), so the route answers before that. */
export const CLASSIFY_DEFAULT_DEADLINE_MS = 2500;
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
      recordQuestion('none');
      return undefined;
    }
    if (!questionWasSent(out)) return undefined;
    recordQuestion(out.kind === 'question' ? 'given' : 'none');
    return out.kind === 'question' ? out.question : undefined;
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
 * sent the claim, in configured order. `question` is added only with CLASSIFY_QUESTIONS on, a
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
  const timeoutMs = Math.max(100, deadlineMs - VOTE_HEADROOM_MS);
  const voters = activeVoters(env);
  const { label, outcomes } = await classifyByFreeVotes(trimmed, { env, timeoutMs, voters });
  recordVotes(voters, outcomes);
  const asked = voters.filter((_, i) => {
    const o = outcomes[i];
    return o !== undefined && voteWasSent(o);
  });
  if (asked.length === 0) {
    // No vote left the box, so there is no verdict either: combineVotes can only be not-checked.
    recordLabel(NOT_CHECKED, 'skipped');
    return { label: NOT_CHECKED, by: 'skipped' };
  }
  recordLabel(label, 'votes');
  const answer = { label, by: 'votes' as const, voters: asked.map((v) => v.provider) };
  if (options.question === false || label !== NOT_CHECKED || !questionsEnabled(env) || !bothUnsure(outcomes)) {
    return answer;
  }
  const question = await questionWithin(trimmed, voters, outcomes, deadlineMs - (performance.now() - started), env);
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
