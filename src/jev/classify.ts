/**
 * Jev label call: sends { state, labels } to a LOCAL model and returns label + score.
 *
 * VETO-ONLY (B9, Sean 2026-10-03: "A model may not say pass"). The label is veto or
 * not-checked. A model `pass` is read as not-checked: a pass comes only from a
 * deterministic check (the route's arithmetic), never from a model's opinion.
 * Never `reject`, never 0 for "no answer". See docs/plans/B9_LOCAL_MODEL.md.
 * - No model URL, a non-local URL, a timeout, a non-200, an empty or oversized body,
 *   unparseable JSON, or a label outside the three is not-checked with score null.
 * - A score with no label is not-checked, not 0. A score is returned only beside
 *   veto, and only when it is a number in [0, 1].
 * - Over SLOW_MS the label is not-checked and line is 'Still checking' (the same
 *   line and threshold as the extension's laya.js).
 * - The label comes only from the model's `label` field. A reply whose text ends
 *   in "veto" is not a veto unless the model answers veto.
 *
 * NO PAID MODEL, NO ANTHROPIC. The model URL must be a loopback host
 * (localhost, 127.0.0.1, ::1). An allow-list, not a deny-list of vendor names:
 * a deny-list fails open for every vendor added later. OpenRouter's System One
 * route (where Jev is hosted, see src/hal/jev-prefilter.ts) needs a paid account
 * key, so it is refused here by construction. No Authorization header is sent.
 *
 * STORES NOTHING. No database import, no insert. The request carries the reply
 * text as `state` (capped) and the three labels — no user id, no key, nothing else.
 *
 * INERT UNTIL WIRED. Nothing calls this yet; POST /api/v1/classify still uses its
 * own arithmetic-only classifier. Wiring it in is a separate change.
 */

export type JevLabel = 'pass' | 'veto' | 'not-checked';

export const JEV_LABELS: readonly JevLabel[] = ['pass', 'veto', 'not-checked'];
export const NOT_CHECKED: JevLabel = 'not-checked';
export const SLOW_MS = 3000;
export const SLOW_LINE = 'Still checking';
/** Stop waiting just past SLOW_MS; a later answer could not count anyway. */
export const TIMEOUT_MS = SLOW_MS + 100;
const STATE_CAP = 2000;
const MAX_BODY_CHARS = 64 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface JevClassifyResult {
  label: JevLabel;
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

function unitScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Reads { label, score }. Only `veto` survives; `pass` and anything else is not-checked with no score. */
export function readJevAnswer(body: unknown): { label: JevLabel; score: number | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { label: NOT_CHECKED, score: null };
  const raw = (body as { label?: unknown }).label;
  const label = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (label !== 'veto') return { label: NOT_CHECKED, score: null };
  return { label, score: unitScore((body as { score?: unknown }).score) };
}

export async function jevClassify(text: string, options: JevClassifyOptions = {}): Promise<JevClassifyResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const done = (answer: { label: JevLabel; score: number | null }): JevClassifyResult => {
    const latency_ms = Math.max(0, Math.round(now() - started));
    if (latency_ms > SLOW_MS) return { label: NOT_CHECKED, score: null, latency_ms, line: SLOW_LINE };
    return { label: answer.label, score: answer.score, latency_ms };
  };
  const notChecked = { label: NOT_CHECKED, score: null };

  const state = typeof text === 'string' ? text.trim() : '';
  if (!state) return done(notChecked);
  const url = localModelUrl(options.modelUrl === undefined ? process.env['JEV_CLASSIFY_URL'] : options.modelUrl);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!url || typeof fetchImpl !== 'function') return done(notChecked);

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
        body: JSON.stringify({ state: state.slice(0, STATE_CAP), labels: JEV_LABELS }),
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
      return { label: NOT_CHECKED, score: null, latency_ms: Math.max(0, Math.round(now() - started)), line: SLOW_LINE };
    }
    return done(readJevAnswer(body));
  } catch {
    return done(notChecked);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
