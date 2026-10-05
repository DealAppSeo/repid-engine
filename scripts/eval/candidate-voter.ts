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
 * Exit codes: 0 finished, 2 NOT_CHECKED (no key, host unreachable, id not listed), 1 bad arguments.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import {
  BUDGET_PER_MIN,
  castVote,
  combineVotes,
  parseVoters,
  type Verdict,
  type VoteLabel,
  type VoteOutcome,
  type Voter,
} from '../../src/classify/free-votes';
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

/** The host's own list of model ids, or null when it could not be read (NOT_CHECKED, never "absent"). */
export async function listedModels(voter: Voter, key: string, fetchImpl: typeof fetch = fetch): Promise<Set<string> | null> {
  const chat =
    voter.provider === 'nvidia-nim'
      ? PROVIDER_URLS.nvidiaNimChatCompletions
      : voter.provider === 'groq'
        ? PROVIDER_URLS.groqChatCompletions
        : voter.provider === 'cerebras'
          ? PROVIDER_URLS.cerebrasChatCompletions
          : null;
  if (!chat) return null;
  try {
    const res = await fetchImpl(chat.replace(/\/chat\/completions$/, '/models'), {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return new Set((json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string'));
  } catch {
    return null;
  }
}

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
  const listed = await listedModels(voter, key);
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

  for (const c of todo) {
    const started = Date.now();
    const outcome = await castVote(voter, c.claim, { timeoutMs: 15_000, extraBody });
    const row: CandidateRow = { row_id: c.row_id, outcome, ms: Date.now() - started };
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const wait = pauseMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  const summary = pairSummary(baseline, readJsonl<CandidateRow>(out));
  console.log(JSON.stringify(summary, null, 2));
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
