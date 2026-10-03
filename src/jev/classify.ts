/**
 * Local decision-model call over the System One contract (P1 in docs/plans/CASCADE_EVAL.md).
 *
 * Sends ONE typed question to a LOOPBACK System One server (`laya-serve`, or anything else
 * speaking Jev's `POST /v1/systemone` shape) and returns { label, score, latency_ms }.
 *
 *   request:  { state: { reply }, questions: { has_error: { type: "noul", instructions } } }
 *   response: { answers: { has_error: { noul: <p> } } }   (a flat { has_error: ... } is read too)
 *
 * WHY ONE `noul`, NOT A `choice` OF veto / not-checked. A choice is softmaxed over its own
 * options, so a reply with nothing wrong in it would have nowhere true to go, and every
 * shift of mass toward "veto" is a false veto, which is the number the B9 bar gates on.
 * A noul is a probability that the reply contains a checkable error; the client vetoes
 * only above VETO_THRESHOLD and calls everything else not-checked.
 *
 * VETO-ONLY (B9, Sean 2026-10-03: "A model may not say pass"). The model is never offered
 * `pass` and this client can return only `veto` or `not-checked`. A pass comes only from a
 * deterministic check (the route's arithmetic), never from a model's opinion. A low
 * probability means "the model saw no error", which is an opinion, so it is not-checked.
 *
 * FAILS CLOSED. No model URL, a non-loopback URL, a timeout, a non-200, an empty, oversized
 * or unparseable body, or an answer outside [0, 1] is not-checked with score null — never 0,
 * never pass. Over SLOW_MS it is not-checked plus 'Still checking' (same line and threshold
 * as the extension's laya.js). The reply's own words cannot pick the label: a reply ending in
 * "veto" is a veto only when the model's probability says so.
 *
 * LOOPBACK ONLY, NO KEY. The URL must be http(s) on localhost, 127.0.0.1 or ::1 — an
 * allow-list, because a deny-list of vendor names fails open for every vendor added later.
 * No Authorization header is sent, so hosted Jev (which needs a paid key) is refused by
 * construction. Loopback is a property of this CLIENT: `laya-serve` binds 0.0.0.0 with no
 * auth by default, so binding the server to 127.0.0.1 is the operator's job.
 *
 * STORES NOTHING. No database import, no insert. The request carries the reply (capped) and
 * the one question — no user id, no key, nothing else.
 *
 * INERT UNTIL WIRED. Nothing calls this; POST /api/v1/classify is arithmetic-only, and the
 * flag that would wire it (CLASSIFY_LOCAL_MODEL_ENABLED) is not built. See
 * docs/plans/B9_LOCAL_MODEL.md.
 */

export type JevLabel = 'veto' | 'not-checked';

export const NOT_CHECKED: JevLabel = 'not-checked';
export const SLOW_MS = 3000;
export const SLOW_LINE = 'Still checking';
/** Stop waiting just past SLOW_MS; a later answer could not count anyway. */
export const TIMEOUT_MS = SLOW_MS + 100;
/** The one question, and the key its answer comes back under. */
export const QUESTION_KEY = 'has_error';
export const QUESTION =
  'Does this chat reply state something checkably wrong: a false fact, a wrong number, or a wrong calculation?';
/**
 * Veto at or above this probability. UNCALIBRATED PLACEHOLDER, set high on purpose: the
 * B9 evaluation replaces it with a value fitted on the labelled set. Nothing is wired, so
 * this number decides nothing today.
 */
export const VETO_THRESHOLD = 0.9;
const STATE_CAP = 2000;
const MAX_BODY_CHARS = 64 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface JevClassifyResult {
  label: JevLabel;
  /** The model's probability, only beside a veto. Null whenever the label is not-checked. */
  score: number | null;
  latency_ms: number;
  line?: typeof SLOW_LINE;
}

type FetchLike = (url: string, init: RequestInit) => Promise<{
  status: number;
  text: () => Promise<string>;
}>;

export interface JevClassifyOptions {
  /** Defaults to env JEV_CLASSIFY_URL. Must be http(s) on a loopback host. */
  modelUrl?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  vetoThreshold?: number;
}

/** A loopback http(s) URL, or null. */
export function localModelUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return LOCAL_HOSTS.has(url.hostname) ? url.toString() : null;
}

function unit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * The noul probability for QUESTION_KEY, or null. Accepts the answer nested under
 * `answers` (laya's documented envelope) or at the root, as a bare number or as an object
 * carrying `noul` / `probability` / `value`. The live HTTP body has not been logged yet;
 * pin the observed shape once it is.
 */
export function readNoul(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  const answers = root['answers'];
  const containers = [answers && typeof answers === 'object' ? answers : null, root];
  for (const c of containers) {
    if (!c) continue;
    const entry = (c as Record<string, unknown>)[QUESTION_KEY];
    if (typeof entry === 'number') return unit(entry);
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>;
      for (const f of ['noul', 'probability', 'value']) {
        if (o[f] !== undefined) return unit(o[f]);
      }
    }
  }
  return null;
}

/** Probability → label. Only a probability at or above the threshold is a veto. */
export function labelFor(p: number | null, threshold: number = VETO_THRESHOLD): { label: JevLabel; score: number | null } {
  return p !== null && p >= threshold ? { label: 'veto', score: p } : { label: NOT_CHECKED, score: null };
}

export async function jevClassify(text: string, options: JevClassifyOptions = {}): Promise<JevClassifyResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const elapsed = (): number => Math.max(0, Math.round(now() - started));
  const done = (answer: { label: JevLabel; score: number | null }): JevClassifyResult => {
    const latency_ms = elapsed();
    if (latency_ms > SLOW_MS) return { label: NOT_CHECKED, score: null, latency_ms, line: SLOW_LINE };
    return { label: answer.label, score: answer.score, latency_ms };
  };
  const notChecked = { label: NOT_CHECKED, score: null };

  const reply = typeof text === 'string' ? text.trim() : '';
  if (!reply) return done(notChecked);
  const url = localModelUrl(options.modelUrl === undefined ? process.env['JEV_CLASSIFY_URL'] : options.modelUrl);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!url || typeof fetchImpl !== 'function') return done(notChecked);
  const threshold = unit(options.vetoThreshold) ?? VETO_THRESHOLD;

  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    const call = (async (): Promise<unknown> => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: { reply: reply.slice(0, STATE_CAP) },
          questions: { [QUESTION_KEY]: { type: 'noul', instructions: QUESTION } },
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res || res.status !== 200) return null;
      const raw = await res.text();
      if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_BODY_CHARS) return null;
      return JSON.parse(raw) as unknown;
    })();
    // After a timeout the abandoned call may still reject; that is not an unhandled error.
    call.catch(() => undefined);
    const body = await Promise.race([call, timeout]);
    if (controller.signal.aborted) {
      // A timeout is the slow case by definition: say so, whatever the clock reads.
      return { label: NOT_CHECKED, score: null, latency_ms: elapsed(), line: SLOW_LINE };
    }
    return done(labelFor(readNoul(body), threshold));
  } catch {
    return done(notChecked);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
