/**
 * T12 attempt: the real call behind t12Wave, one host at a time. Flag off by default: t12Wave
 * returns NOT_CHECKED unless T12_FREE_WAVE is the exact string true. Its first caller is the
 * B21 runner job (src/orchestration/t12-runner-job.ts), which sets the flag for one GitHub
 * Actions job only. THIS LINE USED TO SAY "nothing calls t12Ask"; that stopped being true
 * with B21.
 *
 * WHERE EACH STEP GOES, and why it is not resolveProviderEndpoint:
 * - local    → <T12_LOCAL_BASE_URL>/chat/completions, loopback only, NO Authorization header.
 * - cloud    → T12_ROUTES below, each with its own key. Nothing else can be reached from here.
 * The cloud steps use the registry URL directly. resolveProviderEndpoint would rewrite them to
 * LOCAL_LLM_BASE_URL when that process-wide redirect is set, which would send "local down, try
 * groq" back to the same local server and hand it the groq key (CC2 review of #1170). Each
 * key goes only to its own host.
 *
 * EGRESS: every call goes through providerFetch (the named chokepoint) and asserts the
 * ONLY_ATTESTATIONS_LEAVE boundary first. Under the boundary a cloud step is refused before
 * any byte leaves, and the wave moves on; the loopback step is allowed. The boundary is ON if
 * ANY source says so — the boundaryOn option, the env passed in, or the process env — so a
 * caller can only TIGHTEN it, never switch a node's boundary off (CC2 review of #1171).
 *
 * WHAT COUNTS AS AN ANSWER: a 2xx whose body has non-empty choices[0].message.content. A 2xx
 * with an empty or unparseable body is NOT an answer: it is reported as a non-2xx so the wave
 * tries the next host, and it can never end the wave looking like success. A 429 passes its
 * Retry-After back. Stores nothing; writes no row.
 */
import { providerFetch } from '../egress/provider-fetch';
import { PROVIDER_URLS } from '../egress/provider-hosts';
import { assertPromptEgressAllowed, onlyAttestationsLeave } from '../selfhost/egress-guard';
import { t12LocalBase, t12Wave, type T12WaveResult } from './t12-free-wave';

/** Per host. A full three-host wave can therefore take up to ~60 s before NOT_CHECKED. */
export const T12_TIMEOUT_MS = 20000;
/** Longest wait a host's Retry-After may impose: a hostile or buggy header cannot park the loop. */
export const T12_MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
/** Status reported for a 2xx whose body held no usable answer: outside 2xx and not 429, so the wave moves on. */
export const T12_EMPTY_ANSWER = 0;
const MAX_BODY_CHARS = 256 * 1024;

type Env = Record<string, string | undefined>;
type FetchLike = (url: string, init: RequestInit) => Promise<{
  status: number;
  headers?: { get(name: string): string | null } | null;
  text: () => Promise<string>;
}>;

export interface T12Target {
  url: string;
  /** Null for the local step: a local host is sent no key. */
  key: string | null;
  model: string;
  body?: Record<string, unknown>;
}

interface T12Route {
  url: string;
  keyEnv: readonly string[];
  model: string;
  body?: Record<string, unknown>;
}

/**
 * The only cloud routes T12 can reach, each measured answering on 2026-11-08 (t12-lane-route.ts).
 * Adding a provider means adding it here, so a key being present never makes a host eligible.
 * A model id here used to come from WORKING_FREE_PROVIDERS, whose Cerebras entry is archived (404).
 */
export const T12_ROUTES: Readonly<Record<string, T12Route>> = {
  groq: { url: PROVIDER_URLS.groqChatCompletions, keyEnv: ['GROQ_API_KEY'], model: 'openai/gpt-oss-20b' },
  cerebras: { url: PROVIDER_URLS.cerebrasChatCompletions, keyEnv: ['CEREBRAS_API_KEY'], model: 'gpt-oss-120b' },
  nvidia: { url: PROVIDER_URLS.nvidiaNimChatCompletions, keyEnv: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'], model: 'poolside/laguna-xs-2.1' },
  // This account holds paid credit, so a free id alone is not enough: the price cap makes OpenRouter
  // refuse rather than bill if the free route ever changes.
  openrouter: {
    url: PROVIDER_URLS.openrouterChatCompletions,
    keyEnv: ['OPENROUTER_API_KEY'],
    model: 'nvidia/nemotron-3.5-lightning:free',
    body: { provider: { max_price: { prompt: 0, completion: 0 } } },
  },
};

export interface T12RouteAttempt {
  host: string;
  model: string;
  status: number | null;
  reason: string;
  retryAfterMs?: number;
}

/** Where one host's call goes. Null when the host has no endpoint or no key. */
export function t12Target(host: string, env: Env = process.env): T12Target | null {
  if (host === 'local') {
    const base = t12LocalBase(env);
    if (!base) return null;
    const url = `${base.replace(/\/+$/, '')}/chat/completions`;
    return { url, key: null, model: env.T12_LOCAL_MODEL?.trim() || 'local' };
  }
  if (!Object.prototype.hasOwnProperty.call(T12_ROUTES, host)) return null;
  const route = T12_ROUTES[host]!;
  const key = route.keyEnv.map((name) => env[name]?.trim()).find(Boolean);
  return key ? { url: route.url, key, model: route.model, ...(route.body ? { body: route.body } : {}) } : null;
}

/** Retry-After as ms: integer seconds, or an HTTP date. Undefined when absent or unreadable. */
export function retryAfterMs(raw: string | null | undefined, now: number = Date.now()): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const v = raw.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    ms = Number.isFinite(at) ? Math.max(0, at - now) : undefined;
  }
  return ms === undefined || !Number.isFinite(ms) ? undefined : Math.min(ms, T12_MAX_RETRY_AFTER_MS);
}

/** True when any source engages ONLY_ATTESTATIONS_LEAVE. An explicit false cannot disengage it. */
export function t12BoundaryOn(env: Env, explicit?: boolean): boolean {
  // One reader for the variable (onlyAttestationsLeave: trimmed, case-insensitive); either source on wins.
  return explicit === true || onlyAttestationsLeave(env) || onlyAttestationsLeave(process.env);
}

/** choices[0].message.content when it is a non-empty string; otherwise null. */
export function readAnswer(text: string): string | null {
  if (text.length === 0 || text.length > MAX_BODY_CHARS) return null;
  try {
    const body = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() !== '' ? content : null;
  } catch {
    return null;
  }
}

export interface T12AskResult extends T12WaveResult {
  /** The answering host's text. Null unless outcome is 'answered'. */
  text: string | null;
}

/**
 * Ask the free wave one prompt. Off (T12_FREE_WAVE not exactly 'true') is NOT_CHECKED and
 * makes no call. The API service does not call this; the B21 runner job does.
 */
export async function t12Ask(
  prompt: string,
  options: {
    env?: Env;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    boundaryOn?: boolean;
    /** Hosts to try instead of the default order. */
    order?: readonly string[];
    /** Called once per host tried. Its failure never costs an answer. */
    onAttempt?: (a: T12RouteAttempt) => Promise<void> | void;
  } = {},
): Promise<T12AskResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? (providerFetch as unknown as FetchLike);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : T12_TIMEOUT_MS;
  const answers = new Map<string, string>();
  const boundaryOn = t12BoundaryOn(env, options.boundaryOn);

  const attempt = async (host: string): Promise<{ status: number; retryAfterMs?: number }> => {
    const target = t12Target(host, env);
    const record = async (status: number | null, reason: string, retry?: number): Promise<void> => {
      try {
        await options.onAttempt?.({ host, model: target?.model ?? '', status, reason, ...(retry === undefined ? {} : { retryAfterMs: retry }) });
      } catch {
        // A lost ledger write is not a lost answer.
      }
    };
    if (!target) {
      await record(null, 'no_credentials');
      throw new Error(`t12: no endpoint or key for ${host}`);
    }
    // Refused under ONLY_ATTESTATIONS_LEAVE for a cloud step; throws → next host.
    try {
      assertPromptEgressAllowed(target.url, 'prompt', boundaryOn);
    } catch (e) {
      await record(null, 'egress_refused');
      throw e;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (target.key) headers.Authorization = `Bearer ${target.key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target.url, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({ model: target.model, messages: [{ role: 'user', content: prompt }], ...target.body }),
      });
      if (res.status === 429) {
        const ra = retryAfterMs(res.headers?.get('retry-after') ?? null);
        await record(429, 'rate_limited', ra);
        return ra === undefined ? { status: 429 } : { status: 429, retryAfterMs: ra };
      }
      if (res.status < 200 || res.status >= 300) {
        await record(res.status, `http_${res.status}`);
        return { status: res.status };
      }
      const answer = readAnswer(await res.text());
      if (answer === null) {
        await record(res.status, 'empty_answer');
        return { status: T12_EMPTY_ANSWER };
      }
      answers.set(host, answer);
      await record(res.status, 'answered');
      return { status: res.status };
    } catch (e) {
      await record(null, controller.signal.aborted ? 'timeout' : 'network_error');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  const wave = await t12Wave({ env, attempt, ...(options.order ? { order: options.order } : {}) });
  const text = wave.outcome === 'answered' && wave.host ? answers.get(wave.host) ?? null : null;
  // An 'answered' with no stored text cannot happen through this attempt; if it ever did,
  // it must not read as success.
  if (wave.outcome === 'answered' && text === null) return { ...wave, outcome: 'NOT_CHECKED', host: null, text: null };
  return { ...wave, text };
}
