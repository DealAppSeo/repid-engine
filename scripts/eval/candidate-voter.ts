/**
 * Evaluate a CANDIDATE second voter for POST /api/v1/classify without touching production.
 *
 *   npm run eval:candidate-voter -- --voter nvidia-nim:<model id> [--extra-body '<json>'] [--limit 337]
 *
 * WHY THIS SHAPE. Production pairs Groq `openai/gpt-oss-120b` with Cerebras `qwen-3.8-27b`, and a pass
 * or veto needs both to agree. eval/rigorous/baseline-classify-2026-10-05.jsonl holds what each of
 * those two said on all 337 labelled claims (one production run, 2026-10-05). So a candidate only
 * has to answer the 337 claims ONCE: pairing its verdicts with the stored Groq verdicts gives the
 * label production WOULD have produced, without a single Groq call. On 2026-10-05 eval traffic spent
 * Groq's 1,000 requests a day and took live checks down to Not checked; this harness never calls Groq
 * unless told to with --allow-shared-quota.
 *
 * WHY NVIDIA IS EVALUATION-ONLY. NVIDIA's API catalog keys are for "research, development, and test
 * use only"; production is "any non-testing activity including activity serving real end-users"
 * (NVIDIA NIM FAQ). This harness is test use: public labelled claims, never a user's text. A model
 * that wins here is served in production from a host whose terms allow it, never from this key.
 *
 * WHAT IT USES. castVote, the production voting path: the same prompt, parser, timeout and per-minute
 * budget. The key comes from the session environment (NVIDIA_NIM_API_KEY for nvidia-nim), never from
 * an argument. Before any claim it checks the model id is listed by the host's own /models endpoint
 * with that key: an id copied from a docs page is not evidence it answers (src/hal/retired-models.ts).
 *
 * WHAT IS NOT AN ANSWER. After a failed call castVote pauses that model for FAILURE_COOL_MS, which
 * protects users in production. The first Kimi K2.6 run (2026-10-06, run 37434186754) paced one
 * claim every 1.9 s, so each failure was followed by about 30 claims refused while paused, and every
 * one was recorded as the model's answer: 337 of 337 abstains at 0 ms, printed as a findings row
 * reading "172 → 0 decided". The model had been asked about ten times (11 minutes of 60-second pauses). A refusal that never reached
 * the host (paused, over budget, no key) is this harness's own state, so it is never recorded: a
 * pause is waited out and the claim asked again; anything else stops the run.
 *
 * RETIRED AS A HOLDOUT (S60, 2026-10-07). The 337 claims are public, so a trial row is a
 * comparison on a public set, never a holdout score: the summary carries `holdout: "retired-public"`
 * and the printed line says so (scripts/eval/retired-holdout.ts).
 *
 * Exit codes: 0 finished, 2 NOT_CHECKED (no key, host unreachable, id not listed, the candidate
 * failed STREAK_LIMIT calls in a row, or answered nothing), 1 bad arguments.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  BUDGET_PER_MIN,
  castVote,
  combineVotes,
  encodeClaim,
  FAILURE_COOL_MS,
  parseVerdict,
  parseVoters,
  unparseableShape,
  votePrompt,
  voteWasSent,
  type Verdict,
  type VoteLabel,
  type VoteOutcome,
  type Voter,
} from '../../src/classify/free-votes';
import { providerFetch, type ProviderFetch } from '../../src/egress/provider-fetch';
import { PROVIDER_URLS } from '../../src/egress/provider-hosts';
import { retiredLine, retiredStamp } from './retired-holdout';

export interface BaselineRow {
  row_id: string;
  label_truth: 'TRUE' | 'FALSE';
  groq_gpt_oss_120b: string | null;
  cerebras_qwen_3_8_27b: string | null;
  production_label: VoteLabel;
}

export interface CandidateRow {
  row_id: string;
  outcome: VoteOutcome;
  ms: number;
}

/** A stored baseline reading back as the outcome castVote returned; null when it was ambiguous. */
export function outcomeOf(stored: string | null): VoteOutcome | null {
  if (stored === null) return null;
  if (stored === 'TRUE' || stored === 'FALSE' || stored === 'UNSURE') return { kind: 'verdict', verdict: stored as Verdict };
  const reason = stored.startsWith('abstain:') ? stored.slice('abstain:'.length) : stored;
  return { kind: 'abstain', reason } as VoteOutcome;
}

export interface Tally {
  n: number;
  decided: number;
  correct: number;
  falseShownPass: number;
  trueShownVeto: number;
}

function tally(rows: Array<{ truth: 'TRUE' | 'FALSE'; label: VoteLabel }>): Tally {
  const t: Tally = { n: rows.length, decided: 0, correct: 0, falseShownPass: 0, trueShownVeto: 0 };
  for (const r of rows) {
    if (r.label === 'not-checked') continue;
    t.decided += 1;
    const right = (r.label === 'pass') === (r.truth === 'TRUE');
    if (right) t.correct += 1;
    if (r.label === 'pass' && r.truth === 'FALSE') t.falseShownPass += 1;
    if (r.label === 'veto' && r.truth === 'TRUE') t.trueShownVeto += 1;
  }
  return t;
}

/**
 * Production as measured vs. Groq paired with the candidate, over the rows where both the stored Groq
 * reading and the candidate's answer exist. Rows with an ambiguous stored reading are left out and
 * counted, never guessed.
 */
export function pairSummary(baseline: BaselineRow[], candidate: CandidateRow[]) {
  const byId = new Map(candidate.map((c) => [c.row_id, c]));
  const prod: Array<{ truth: 'TRUE' | 'FALSE'; label: VoteLabel }> = [];
  const paired: Array<{ truth: 'TRUE' | 'FALSE'; label: VoteLabel }> = [];
  const transitions = new Map<string, number>();
  let skippedAmbiguous = 0;
  let notRunYet = 0;
  for (const b of baseline) {
    const c = byId.get(b.row_id);
    if (!c) {
      notRunYet += 1;
      continue;
    }
    const groq = outcomeOf(b.groq_gpt_oss_120b);
    if (!groq) {
      skippedAmbiguous += 1;
      continue;
    }
    const label = combineVotes(groq, c.outcome);
    prod.push({ truth: b.label_truth, label: b.production_label });
    paired.push({ truth: b.label_truth, label });
    const k = `${b.production_label} -> ${label}`;
    transitions.set(k, (transitions.get(k) ?? 0) + 1);
  }
  return {
    production: tally(prod),
    groqPlusCandidate: tally(paired),
    transitions: Object.fromEntries([...transitions.entries()].sort((a, b) => b[1] - a[1])),
    skippedAmbiguous,
    notRunYet,
  };
}

/**
 * Where a host lists the model ids a key can call. OpenAI-shaped hosts answer `/models` beside
 * `/chat/completions`; Workers AI lists per account through Cloudflare's own API, and its ids are
 * the `@cf/...` names. Null when there is no list to read, which the caller reports as NOT_CHECKED.
 */
export function modelsUrl(voter: Voter, env: NodeJS.ProcessEnv = process.env): string | null {
  if (voter.provider === 'nvidia-nim') return PROVIDER_URLS.nvidiaNimChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'groq') return PROVIDER_URLS.groqChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'cerebras') return PROVIDER_URLS.cerebrasChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'openrouter') return PROVIDER_URLS.openrouterChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'together') return PROVIDER_URLS.togetherChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'mistral') return PROVIDER_URLS.mistralChatCompletions.replace(/\/chat\/completions$/, '/models');
  if (voter.provider === 'workers-ai') {
    const account = (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(account)) return null;
    return `${PROVIDER_URLS.cloudflareApiOrigin}/client/v4/accounts/${account}/ai/models/search?per_page=1000`;
  }
  return null;
}

/** The host's own list of model ids, or null when it could not be read (NOT_CHECKED, never "absent"). */
export async function listedModels(
  voter: Voter,
  key: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string> | null> {
  return readModelList(modelsUrl(voter, env), { Authorization: `Bearer ${key}` }, fetchImpl);
}

/** A host's model ids from its list URL, or null when it could not be read (NOT_CHECKED). */
export async function readModelList(
  url: string | null,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string> | null> {
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) return null;
    return idsFromModelList(await res.json());
  } catch {
    return null;
  }
}

/**
 * Model ids from a host's list, whatever its shape: OpenAI `{ data: [{ id }] }`, Cloudflare
 * `{ result: [{ name }] }`, Cohere `{ models: [{ name }] }`, Together's bare `[{ id }]`.
 */
export function idsFromModelList(json: unknown): Set<string> {
  const j = json as { data?: unknown[]; result?: unknown[]; models?: unknown[] } | unknown[];
  const rows: unknown[] = Array.isArray(j) ? j : [...(j.data ?? []), ...(j.result ?? []), ...(j.models ?? [])];
  const ids = rows.map((m) => {
    const r = (m ?? {}) as { id?: unknown; name?: unknown };
    return typeof r.id === 'string' ? r.id : r.name;
  });
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
}

/**
 * EVAL-ONLY HOSTS (Sean, 2026-10-06: "we should test them all"). Hosts the production voting code
 * does not know. They live here, not in src/, so adding one to a trial cannot route a user's text
 * anywhere: a winner reaches production only through src/classify, the privacy page and Sean's GO,
 * like every checker before it. Each call uses the production prompt, claim encoding, token cap and
 * parser (votePrompt, encodeClaim, parseVerdict), so the answers are comparable with the baseline.
 *
 * Endpoints and quirks are from each vendor's own docs, read 2026-10-06; none was called from the
 * agent sandbox (its network policy refuses them), so the first run is the first measurement.
 */
export interface EvalHost {
  chatUrl: (env: NodeJS.ProcessEnv) => string | null;
  /** null: the host publishes no model list; the id is taken as given. */
  modelsUrl: (env: NodeJS.ProcessEnv) => string | null;
  keyVar: string;
  perMin: number;
  listHeaders?: (key: string) => Record<string, string>;
  /** Some models reject a non-default temperature outright (400 on every call). */
  sendsTemperature?: (model: string) => boolean;
  note: string;
}

const fixedUrl = (u: string) => () => u;
function litellmBase(env: NodeJS.ProcessEnv): string | null {
  const raw = (env.LITELLM_URL ?? '').trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export const EVAL_HOSTS: Record<string, EvalHost> = {
  deepseek: {
    chatUrl: fixedUrl('https://api.deepseek.com/chat/completions'),
    modelsUrl: fixedUrl('https://api.deepseek.com/models'),
    keyVar: 'DEEPSEEK_API_KEY',
    perMin: 60,
    note: 'thinking is ON by default and temperature is ignored while it is; send {"thinking":{"type":"disabled"}}',
  },
  xai: {
    chatUrl: fixedUrl('https://api.x.ai/v1/chat/completions'),
    modelsUrl: fixedUrl('https://api.x.ai/v1/models'),
    keyVar: 'XAI_API_KEY',
    perMin: 60,
    note: 'use a non-reasoning model id (e.g. grok-4.20-0309-non-reasoning)',
  },
  gemini: {
    chatUrl: fixedUrl('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
    modelsUrl: fixedUrl('https://generativelanguage.googleapis.com/v1beta/openai/models'),
    keyVar: 'GEMINI_API_KEY',
    perMin: 10,
    note: 'free-tier prompts may be used by Google; the labelled corpus is public, a user\'s text is not. {"reasoning_effort":"none"} on 2.5 Flash / Flash-Lite',
  },
  anthropic: {
    chatUrl: fixedUrl('https://api.anthropic.com/v1/chat/completions'),
    modelsUrl: fixedUrl('https://api.anthropic.com/v1/models'),
    listHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    keyVar: 'ANTHROPIC_API_KEY',
    perMin: 40,
    // Claude 5-family and Opus 4.7/4.8 answer 400 to any non-default temperature; Haiku 4.5 accepts 0.
    sendsTemperature: (model) => /haiku/i.test(model),
    note: 'OpenAI-compatibility layer; temperature is sent only to Haiku',
  },
  cohere: {
    chatUrl: fixedUrl('https://api.cohere.ai/compatibility/v1/chat/completions'),
    modelsUrl: fixedUrl('https://api.cohere.com/v1/models?endpoint=chat'),
    keyVar: 'COHERE_API_KEY',
    perMin: 15,
    note: 'a trial key allows 20 a minute and 1,000 calls a month, and is not for production',
  },
  perplexity: {
    chatUrl: fixedUrl('https://api.perplexity.ai/router/v1/chat/completions'),
    modelsUrl: fixedUrl('https://api.perplexity.ai/router/v1/models'),
    keyVar: 'PERPLEXITY_API_KEY',
    perMin: 40,
    note: 'the Router endpoint; Sonar chat completions ended 2026-09-27',
  },
  asi1: {
    chatUrl: fixedUrl('https://api.asi1.ai/v1/chat/completions'),
    modelsUrl: () => null,
    keyVar: 'ASI1_API_KEY',
    perMin: 20,
    note: 'no model list; {"enable_thinking":false} for asi1-mini',
  },
  huggingface: {
    chatUrl: fixedUrl('https://router.huggingface.co/v1/chat/completions'),
    modelsUrl: fixedUrl('https://router.huggingface.co/v1/models'),
    keyVar: 'HUGGINGFACE_API_TOKEN',
    perMin: 20,
    note: 'Inference Providers router; free accounts get $0.10 a month of credit',
  },
  litellm: {
    chatUrl: (env) => {
      const b = litellmBase(env);
      return b ? `${b}/v1/chat/completions` : null;
    },
    modelsUrl: (env) => {
      const b = litellmBase(env);
      return b ? `${b}/v1/models` : null;
    },
    keyVar: 'LITELLM_MASTER_KEY',
    perMin: 30,
    note: 'our own gateway (LITELLM_URL); it reaches whatever it is configured with',
  },
};

/** Production voters' own ids: trialling them would spend production's quota. */
const SHARED_QUOTA = new Set(['groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b', 'groq:qwen/qwen3.8-27b']);
export function sharesProductionQuota(provider: string, model: string): boolean {
  return provider === 'cerebras' || SHARED_QUOTA.has(`${provider}:${model}`);
}

/**
 * One vote from an eval-only host, asked exactly as production asks (system prompt, encoded
 * claim, 400-token cap, temperature 0 where the model accepts it) and parsed by the production
 * parser. A 429 waits for Retry-After (20 s if absent) and asks again, up to 3 times: the host's
 * pacing, not the model's answer.
 */
export async function castEvalVote(
  cfg: EvalHost,
  model: string,
  claim: string,
  opts: {
    key: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    extraBody?: Record<string, unknown>;
    fetchImpl?: ProviderFetch;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<VoteOutcome> {
  const env = opts.env ?? process.env;
  const url = cfg.chatUrl(env);
  if (!url) return { kind: 'abstain', reason: 'no_key' };
  const body: Record<string, unknown> = {
    model,
    max_tokens: 400,
    messages: [
      { role: 'system', content: votePrompt(env) },
      { role: 'user', content: encodeClaim(claim) },
    ],
  };
  if (cfg.sendsTemperature?.(model) ?? true) body.temperature = 0;
  if (opts.extraBody) {
    const fixed: Record<string, unknown> = { model: body.model, messages: body.messages, max_tokens: body.max_tokens };
    if ('temperature' in body) fixed.temperature = body.temperature;
    Object.assign(body, opts.extraBody, fixed);
  }
  const doFetch = opts.fetchImpl ?? providerFetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      return { kind: 'abstain', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
    }
    if (res.status === 429 && attempt < 3) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 120) * 1000 : 20_000);
      continue;
    }
    if (res.status === 429) return { kind: 'abstain', reason: 'rate_limited' };
    if (!res.ok) return { kind: 'abstain', reason: 'http_error' };
    let content: unknown;
    try {
      content = ((await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
    } catch {
      content = undefined;
    }
    const verdict = parseVerdict(content);
    return verdict ? { kind: 'verdict', verdict } : { kind: 'abstain', reason: 'unparseable', shape: unparseableShape(content) };
  }
}

/**
 * What the candidate itself answered, apart from any pairing: verdict counts, abstains and why,
 * median time. The median is over the calls that got an answer: a timeout is the deadline, not the
 * model's speed.
 */
export function candidateProfile(rows: readonly CandidateRow[]) {
  const counts = { TRUE: 0, FALSE: 0, UNSURE: 0, abstain: 0 };
  const abstainWhy: Record<string, number> = {};
  for (const r of rows) {
    if (r.outcome.kind === 'verdict') counts[r.outcome.verdict] += 1;
    else {
      counts.abstain += 1;
      abstainWhy[r.outcome.reason] = (abstainWhy[r.outcome.reason] ?? 0) + 1;
    }
  }
  const ms = rows
    .filter((r) => r.outcome.kind === 'verdict')
    .map((r) => r.ms)
    .sort((a, b) => a - b);
  return { n: rows.length, ...counts, abstainWhy, medianMs: ms.length ? ms[Math.floor((ms.length - 1) / 2)]! : null };
}

/** `timeout 3, unparseable 1`, most first; empty when the candidate never abstained. */
export function abstainNote(why: Record<string, number>): string {
  return Object.entries(why)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
}

/**
 * One row for eval/candidates/README.md, so every trial is written down the same way. The
 * comparison is production as measured (Groq gpt-oss + Cerebras qwen) against Groq gpt-oss + the
 * candidate on the same rows. Fewer wrong stamps matters more than more coverage: a wrong stamp is
 * the failure a user cannot see.
 */
export function findingsRow(
  date: string,
  spec: string,
  summary: ReturnType<typeof pairSummary>,
  profile: ReturnType<typeof candidateProfile>,
): string {
  const p = summary.production;
  const c = summary.groqPlusCandidate;
  const wrong = (t: Tally) => t.falseShownPass + t.trueShownVeto;
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
  return (
    `| ${date} | \`${spec}\` | ${c.n} | ${p.decided} → **${c.decided}** (${pct(p.decided, p.n)} → ${pct(c.decided, c.n)}) ` +
    `| ${wrong(p)} → **${wrong(c)}** | ${profile.TRUE}/${profile.FALSE}/${profile.UNSURE}/${profile.abstain} ` +
    `| ${profile.medianMs === null ? 'n/a' : `${profile.medianMs} ms`} | ${profile.abstain ? `abstains: ${abstainNote(profile.abstainWhy)}` : ''} |`
  );
}

/** Calls in a row that may fail before a run stops and says why, rather than spend its hour. */
export const STREAK_LIMIT = 8;

/**
 * Ask the candidate each claim once, through `cast` (castVote in a real run). Records only answers
 * the host actually gave: a verdict, or a failure after a request (timeout, HTTP error, unparseable).
 * A pause after an earlier failure is waited out and the claim asked again; any other refusal that
 * never reached the host (budget, no key, the boundary) stops the run, because it is this harness's
 * state, not the model's answer. STREAK_LIMIT failed calls in a row also stop it: a model that never
 * answers is a finding about its configuration, and the reasons are what the log should show.
 */
export async function askAll(
  claims: ReadonlyArray<{ row_id: string; claim: string }>,
  deps: {
    cast: (claim: string) => Promise<VoteOutcome>;
    record: (row: CandidateRow) => void;
    sleep: (ms: number) => Promise<void>;
    clock?: () => number;
    paceMs: number;
    coolMs?: number;
  },
): Promise<{ asked: number; stopped: string | null }> {
  const clock = deps.clock ?? Date.now;
  const coolMs = deps.coolMs ?? FAILURE_COOL_MS;
  let asked = 0;
  let streak = 0;
  const streakWhy: Record<string, number> = {};
  for (const c of claims) {
    let started = clock();
    let outcome = await deps.cast(c.claim);
    if (outcome.kind === 'abstain' && outcome.reason === 'cooling') {
      await deps.sleep(coolMs + 1_000);
      started = clock();
      outcome = await deps.cast(c.claim);
    }
    if (!voteWasSent(outcome)) {
      const why = outcome.kind === 'abstain' ? outcome.reason : 'unknown';
      return { asked, stopped: why === 'budget' ? 'budget' : `refused before any request: ${why}` };
    }
    asked += 1;
    deps.record({ row_id: c.row_id, outcome, ms: clock() - started });
    if (outcome.kind === 'abstain') {
      streak += 1;
      streakWhy[outcome.reason] = (streakWhy[outcome.reason] ?? 0) + 1;
      if (streak >= STREAK_LIMIT) return { asked, stopped: `${streak} failed calls in a row (${abstainNote(streakWhy)})` };
    } else {
      streak = 0;
      for (const k of Object.keys(streakWhy)) delete streakWhy[k];
    }
    const wait = deps.paceMs - (clock() - started);
    if (wait > 0) await deps.sleep(wait);
  }
  return { asked, stopped: null };
}

/** Strip anything shaped like a credential from text a host sent back, before it reaches a log. */
export function redactHostText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(nvapi|sk|gsk|csk|sk-or)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/**
 * providerFetch that remembers the first error body per HTTP status, so a run whose calls all fail
 * says what the host said instead of only "http_error". Redacted, first 300 characters.
 */
export function recordingFetch(seen: Map<number, string>, inner: ProviderFetch = providerFetch): ProviderFetch {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!res.ok && !seen.has(res.status)) {
      const text = await res
        .clone()
        .text()
        .catch(() => '');
      seen.set(res.status, redactHostText(text));
    }
    return res;
  };
}

export const FINDINGS_HEADER = [
  '| date | candidate | rows paired | decided: production → with candidate | wrong stamps: production → with candidate | candidate TRUE/FALSE/UNSURE/abstain | median time | notes |',
  '|---|---|---|---|---|---|---|---|',
].join('\n');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const KEY_VAR: Record<Voter['provider'], string> = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  'nvidia-nim': 'NVIDIA_NIM_API_KEY',
  'workers-ai': 'CLOUDFLARE_WORKERS_AI_TOKEN',
  openrouter: 'OPENROUTER_API_KEY',
  zai: 'ZAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
};

/** What a --voter spec names: a production voter host, or an eval-only host (EVAL_HOSTS). */
export type Candidate =
  | { kind: 'voter'; spec: string; provider: string; model: string; voter: Voter }
  | { kind: 'eval'; spec: string; provider: string; model: string; host: EvalHost };

export function parseCandidate(raw: string | undefined): Candidate | null {
  const spec = (raw ?? '').trim();
  const i = spec.indexOf(':');
  if (i <= 0 || i === spec.length - 1) return null;
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  const host = EVAL_HOSTS[provider];
  if (host) return { kind: 'eval', spec, provider, model, host };
  // parseVoters wants a pair; give it the candidate twice and take one.
  const voter = parseVoters(`${spec},${spec}`)[0];
  if (!voter || `${voter.provider}:${voter.model}` !== spec) return null;
  return { kind: 'voter', spec, provider, model, voter };
}

async function main(): Promise<number> {
  const cand = parseCandidate(arg('voter'));
  if (!cand) {
    console.error(
      `usage: --voter <host>:<model id>, host one of groq|cerebras|nvidia-nim|workers-ai|openrouter|zai|mistral|together|fireworks|${Object.keys(EVAL_HOSTS).join('|')} [--extra-body <json>] [--limit N] [--out file]`,
    );
    return 1;
  }
  const spec = cand.spec;
  if (sharesProductionQuota(cand.provider, cand.model) && !process.argv.includes('--allow-shared-quota')) {
    console.error(`REFUSED: ${spec} is a production voter and shares its quota. Pass --allow-shared-quota only with headroom on /api/v1/classify/stats.`);
    return 1;
  }
  const keyVar = cand.kind === 'eval' ? cand.host.keyVar : KEY_VAR[cand.voter.provider];
  const key = (process.env[keyVar] ?? '').trim();
  if (!key) {
    console.log(`NOT_CHECKED: ${keyVar} is not set in this session`);
    return 2;
  }
  if (cand.kind === 'eval' && !cand.host.chatUrl(process.env)) {
    console.log(`NOT_CHECKED: ${cand.provider} has no usable endpoint in this session (for litellm, set LITELLM_URL)`);
    return 2;
  }
  if (cand.kind === 'eval') console.log(`${cand.provider}: ${cand.host.note}`);

  // The id must be on the host's own list. A host that publishes none is said so, and the id is
  // taken as given: a wrong one stops the run at STREAK_LIMIT with the host's own error.
  const listUrl = cand.kind === 'eval' ? cand.host.modelsUrl(process.env) : modelsUrl(cand.voter, process.env);
  const noList = cand.kind === 'eval' ? listUrl === null : cand.provider === 'fireworks';
  if (noList) {
    console.log(`${cand.provider} publishes no model list this harness reads; ${cand.model} is taken as given`);
  } else {
    const listed =
      cand.kind === 'eval'
        ? await readModelList(listUrl, cand.host.listHeaders?.(key) ?? { Authorization: `Bearer ${key}` })
        : await listedModels(cand.voter, key, fetch, process.env);
    if (!listed) {
      console.log(`NOT_CHECKED: could not read the model list from the ${cand.provider} host (network policy or key)`);
      return 2;
    }
    if (!listed.has(cand.model)) {
      const near = [...listed].filter((id) => id.split('/').pop()!.slice(0, 6) === cand.model.split('/').pop()!.slice(0, 6));
      console.log(`NOT_CHECKED: ${cand.model} is not listed by the host${near.length ? `; listed near it: ${near.join(', ')}` : ''}`);
      return 2;
    }
  }

  let extraBody: Record<string, unknown> | undefined;
  const rawExtra = arg('extra-body');
  if (rawExtra) {
    try {
      extraBody = JSON.parse(rawExtra) as Record<string, unknown>;
    } catch {
      console.error('--extra-body is not JSON');
      return 1;
    }
  }

  const corpus = readJsonl<{ row_id: string; claim: string }>('eval/rigorous/rigorous-corpus-v1.jsonl');
  const baseline = readJsonl<BaselineRow>('eval/rigorous/baseline-classify-2026-10-05.jsonl');
  const safe = cand.model.replace(/[^a-z0-9.-]+/gi, '_');
  const out = arg('out') ?? `eval/rigorous/candidate-${cand.provider}-${safe}.jsonl`;
  const done = new Set(existsSync(out) ? readJsonl<CandidateRow>(out).map((r) => r.row_id) : []);
  const limit = Number(arg('limit') ?? corpus.length);
  const todo = corpus.filter((c) => !done.has(c.row_id)).slice(0, Math.max(0, limit));
  // Stay under the voter's per-minute budget, so a run never trips the host's limit.
  const perMin = cand.kind === 'eval' ? cand.host.perMin : BUDGET_PER_MIN[cand.voter.provider];
  const pauseMs = Math.ceil(60_000 / perMin) + 50;
  console.log(`${spec} — ${done.size} done, ${todo.length} to run, one every ${pauseMs} ms`);

  const hostSaid = new Map<number, string>();
  const fetchImpl = recordingFetch(hostSaid);
  let n = 0;
  const run = await askAll(todo, {
    cast: (claim) =>
      cand.kind === 'eval'
        ? castEvalVote(cand.host, cand.model, claim, { key, timeoutMs: 15_000, extraBody, fetchImpl })
        : castVote(cand.voter, claim, { timeoutMs: 15_000, extraBody, fetchImpl }),
    record: (row) => {
      appendFileSync(out, `${JSON.stringify(row)}\n`);
      n += 1;
      if (n % 25 === 0) console.log(`${n} asked; last: ${row.outcome.kind === 'verdict' ? row.outcome.verdict : row.outcome.reason}`);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    paceMs: pauseMs,
  });
  for (const [status, text] of hostSaid) console.log(`the host answered HTTP ${status}: ${text || '(empty body)'}`);
  if (run.stopped) console.log(`stopped after ${run.asked} asked: ${run.stopped}${run.stopped === 'budget' ? '; run again (tomorrow for a daily cap) to continue' : ''}`);

  const rows = existsSync(out) ? readJsonl<CandidateRow>(out) : [];
  const profile = candidateProfile(rows);
  // A candidate that gave no verdict, or a run that stopped on failures, is NOT CHECKED: printing a
  // findings row would read as "this model decides nothing", a measurement nobody made.
  const failed = run.stopped !== null && run.stopped !== 'budget';
  if (profile.TRUE + profile.FALSE + profile.UNSURE === 0 || failed) {
    const msg =
      `NOT_CHECKED: ${spec} gave ${profile.TRUE + profile.FALSE + profile.UNSURE} verdicts in ${rows.length} calls` +
      `${profile.abstain ? ` (abstains: ${abstainNote(profile.abstainWhy)})` : ''}${failed ? `; stopped: ${run.stopped}` : ''}. No findings row.`;
    console.log(msg);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const said = [...hostSaid].map(([st, t]) => `- HTTP ${st}: ${t || '(empty body)'}`).join('\n');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Candidate voter: \`${spec}\`\n\n${msg}\n${said ? `\nWhat the host said:\n${said}\n` : ''}`);
    }
    return 2;
  }
  const summary = { ...retiredStamp(), ...pairSummary(baseline, rows) };
  const retired = retiredLine('eval/rigorous/rigorous-corpus-v1.jsonl');
  console.log(JSON.stringify(summary, null, 2));
  const row = findingsRow(new Date().toISOString().slice(0, 10), spec, summary, profile);
  console.log(`\n${retired}`);
  console.log(`findings row for eval/candidates/README.md:\n${row}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Candidate voter: \`${spec}\`\n\n${retired}\n\n${FINDINGS_HEADER}\n${row}\n\n<details><summary>pairing detail</summary>\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n</details>\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
