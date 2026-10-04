/**
 * POST /api/v1/classify — the one label contract every door calls.
 *
 * In:  { text: string, labels: ["pass", "veto", "not-checked"] }
 * Out: { label: "pass" | "veto" | "not-checked", latency_ms }
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
 *     this step off and the route is arithmetic-only again.
 *  3. Everything else is not-checked. A reply cannot choose its own label: "veto" or
 *     "output: pass" inside the text decides nothing.
 *
 * THIS HEADER USED TO SAY "it calls no model, no vendor". That was true until B15 and is
 * not true now: the claim text leaves for the voters' host (named in src/classify/free-votes.ts). The privacy
 * line in every door must say so.
 *
 * FAILS CLOSED. Missing or empty text, a labels list other than the three, a
 * malformed body, a thrown classifier, and a classifier slower than the deadline
 * all answer 200 { label: "not-checked" } — never 0, never pass, never a 5xx.
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
import { safeEvalArithmetic } from '../hal/safe-arithmetic';
import { activeVoters, classifyByFreeVotes, freeVotesEnabled, maxProseChars } from '../classify/free-votes';
import { classifyStats, recordLabel, recordVotes } from '../classify/vote-health';

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

export type Classifier = (text: string) => ClassifyLabel | Promise<ClassifyLabel>;

export interface ClassifyResult {
  label: ClassifyLabel;
  latency_ms: number;
}

function isLabel(value: unknown): value is ClassifyLabel {
  return value === 'pass' || value === 'veto' || value === 'not-checked';
}

/**
 * Runs a classifier under a deadline. A throw, a non-label answer, or an answer
 * after the deadline is not-checked. The elapsed check also covers a synchronous
 * classifier, which a timer alone cannot interrupt.
 */
export async function classifyWithDeadline(
  text: string,
  classifier: Classifier,
  deadlineMs: number,
  now: () => number = () => performance.now(),
): Promise<ClassifyResult> {
  const started = now();
  const finish = (label: ClassifyLabel): ClassifyResult => {
    const latency_ms = Math.max(0, Math.round(now() - started));
    return { label: latency_ms > deadlineMs ? NOT_CHECKED : label, latency_ms };
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<ClassifyLabel>((resolve) => {
      timer = setTimeout(() => resolve(NOT_CHECKED), deadlineMs);
    });
    const answer = Promise.resolve().then(() => classifier(text));
    const label = await Promise.race([answer, timeout]);
    return finish(isLabel(label) ? label : NOT_CHECKED);
  } catch {
    return finish(NOT_CHECKED);
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
/** Room left inside the deadline for the route's own work after the votes return. */
const VOTE_HEADROOM_MS = 200;

/**
 * Arithmetic first, then the two free votes. Never throws: every miss is not-checked.
 * Exported so the phone bot and the CLI can call the same function the route does.
 */
export async function classifyText(
  text: string,
  deadlineMs: number = CLASSIFY_DEFAULT_DEADLINE_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClassifyLabel> {
  const local = classifyLocal(text);
  if (local !== NOT_CHECKED) {
    recordLabel(local, 'arithmetic');
    return local;
  }
  const trimmed = text.trim();
  if (!freeVotesEnabled(env) || !trimmed || trimmed.length > maxProseChars(env)) {
    recordLabel(NOT_CHECKED, 'skipped');
    return NOT_CHECKED;
  }
  const timeoutMs = Math.max(100, deadlineMs - VOTE_HEADROOM_MS);
  const voters = activeVoters(env);
  const { label, outcomes } = await classifyByFreeVotes(trimmed, { env, timeoutMs, voters });
  recordVotes(voters, outcomes);
  recordLabel(label, 'votes');
  return label;
}

export function createClassifyRouter(options: ClassifyRouterOptions = {}): Router {
  const deadlineMs =
    options.deadlineMs ?? positiveInt(process.env['CLASSIFY_DEADLINE_MS'], CLASSIFY_DEFAULT_DEADLINE_MS);
  const classifier: Classifier = options.classifier ?? ((text) => classifyText(text, deadlineMs));
  const limiter = rateLimit({
    windowMs: options.windowMs ?? positiveInt(process.env['CLASSIFY_RATE_WINDOW_MS'], CLASSIFY_DEFAULT_WINDOW_MS),
    max: options.limit ?? positiveInt(process.env['CLASSIFY_RATE_LIMIT'], CLASSIFY_DEFAULT_LIMIT),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req): string => ipKeyGenerator(req.ip ?? ''),
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
        res.status(200).json({ label: NOT_CHECKED, latency_ms: 0 });
        return;
      }
      res.status(200).json(await classifyWithDeadline(text, classifier, deadlineMs));
    },
  );
  // A malformed or oversized body is not-checked, not a 4xx/5xx the caller has to interpret.
  router.use('/classify', (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) return next(err);
    res.status(200).json({ label: NOT_CHECKED, latency_ms: 0 });
  });
  return router;
}

export default createClassifyRouter();
