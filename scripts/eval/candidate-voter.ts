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
 * Exit codes: 0 finished, 2 NOT_CHECKED (no key, host unreachable, id not listed, the candidate
 * failed STREAK_LIMIT calls in a row, or answered nothing), 1 bad arguments.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  BUDGET_PER_MIN,
  castVote,
  combineVotes,
  FAILURE_COOL_MS,
  parseVoters,
  voteWasSent,
  type Verdict,
  type VoteLabel,
  type VoteOutcome,
  type Voter,
} from '../../src/classify/free-votes';
import { providerFetch, type ProviderFetch } from '../../src/egress/provider-fetch';
import { PROVIDER_URLS } from '../../src/egress/provider-hosts';

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
  const url = modelsUrl(voter, env);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    // OpenAI shape: { data: [{ id }] }. Cloudflare: { result: [{ name }] }.
    const json = (await res.json()) as { data?: Array<{ id?: unknown }>; result?: Array<{ name?: unknown }> };
    const ids = [...(json.data ?? []).map((m) => m.id), ...(json.result ?? []).map((m) => m.name)];
    return new Set(ids.filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
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

async function main(): Promise<number> {
  const spec = arg('voter');
  // parseVoters wants a pair; give it the candidate twice and take one.
  const voter = spec ? parseVoters(`${spec},${spec}`)[0] : undefined;
  if (!spec || !voter || `${voter.provider}:${voter.model}` !== spec.trim()) {
    console.error('usage: --voter <groq|cerebras|nvidia-nim|workers-ai|openrouter|zai|mistral|together|fireworks>:<model id> [--extra-body <json>] [--limit N] [--out file]');
    return 1;
  }
  if ((voter.provider === 'groq' || voter.provider === 'cerebras') && !process.argv.includes('--allow-shared-quota')) {
    console.error(`REFUSED: ${voter.provider} shares its quota with production. Pass --allow-shared-quota only with headroom on /api/v1/classify/stats.`);
    return 1;
  }
  const key = (process.env[KEY_VAR[voter.provider]] ?? '').trim();
  if (!key) {
    console.log(`NOT_CHECKED: ${KEY_VAR[voter.provider]} is not set in this session`);
    return 2;
  }
  const listed = await listedModels(voter, key, fetch, process.env);
  if (!listed) {
    console.log(`NOT_CHECKED: could not read the model list from the ${voter.provider} host (network policy or key)`);
    return 2;
  }
  if (!listed.has(voter.model)) {
    const near = [...listed].filter((id) => id.split('/').pop()!.slice(0, 6) === voter.model.split('/').pop()!.slice(0, 6));
    console.log(`NOT_CHECKED: ${voter.model} is not listed by the host${near.length ? `; listed near it: ${near.join(', ')}` : ''}`);
    return 2;
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
  const safe = voter.model.replace(/[^a-z0-9.-]+/gi, '_');
  const out = arg('out') ?? `eval/rigorous/candidate-${voter.provider}-${safe}.jsonl`;
  const done = new Set(existsSync(out) ? readJsonl<CandidateRow>(out).map((r) => r.row_id) : []);
  const limit = Number(arg('limit') ?? corpus.length);
  const todo = corpus.filter((c) => !done.has(c.row_id)).slice(0, Math.max(0, limit));
  // Stay under the voter's per-minute budget, so a run never trips the host's limit.
  const pauseMs = Math.ceil(60_000 / BUDGET_PER_MIN[voter.provider]) + 50;
  console.log(`${voter.provider}:${voter.model} — ${done.size} done, ${todo.length} to run, one every ${pauseMs} ms`);

  const hostSaid = new Map<number, string>();
  const fetchImpl = recordingFetch(hostSaid);
  let n = 0;
  const run = await askAll(todo, {
    cast: (claim) => castVote(voter, claim, { timeoutMs: 15_000, extraBody, fetchImpl }),
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
      `NOT_CHECKED: ${spec.trim()} gave ${profile.TRUE + profile.FALSE + profile.UNSURE} verdicts in ${rows.length} calls` +
      `${profile.abstain ? ` (abstains: ${abstainNote(profile.abstainWhy)})` : ''}${failed ? `; stopped: ${run.stopped}` : ''}. No findings row.`;
    console.log(msg);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const said = [...hostSaid].map(([st, t]) => `- HTTP ${st}: ${t || '(empty body)'}`).join('\n');
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Candidate voter: \`${spec.trim()}\`\n\n${msg}\n${said ? `\nWhat the host said:\n${said}\n` : ''}`);
    }
    return 2;
  }
  const summary = pairSummary(baseline, rows);
  console.log(JSON.stringify(summary, null, 2));
  const row = findingsRow(new Date().toISOString().slice(0, 10), spec.trim(), summary, profile);
  console.log(`\nfindings row for eval/candidates/README.md:\n${row}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Candidate voter: \`${spec.trim()}\`\n\n${FINDINGS_HEADER}\n${row}\n\n<details><summary>pairing detail</summary>\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n</details>\n`,
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
