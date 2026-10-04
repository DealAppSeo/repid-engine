/**
 * B21 — the first real T12 job: a loopback model inside a free GitHub Actions runner.
 *
 * WHY HERE. T12 agents need a model to work on, and two things were missing: a host that is
 * free and always on, and a caller of `t12Ask` (#1171 shipped it unwired). This repo is public,
 * so Actions minutes are free; `.github/workflows/t12-loopback.yml` starts Ollama INSIDE the
 * runner, so the model is on 127.0.0.1 — a genuine loopback host under the rule #1170 set —
 * with no PC left on and no VPS. The flag is set for that one job only.
 *
 * THE JOB. Dogfood, not a demo: ask each claim of a small fixed, labelled set through the real
 * `t12Ask` path and score the answers. That measures whether a loopback model could ever be a
 * third classify voter (BUS V1-8) — a question the ecosystem actually needs answered — and it
 * leaves a receipt naming the host that answered every call.
 *
 * WHAT IT NEVER DOES. No database write, no key: the workflow passes no secret, so the cloud
 * steps of the wave have no key and are skipped, and every answer that does arrive came from the
 * loopback host. The receipt says so per claim rather than assuming it.
 *
 * EXIT CODES (three outcomes, never two): 0 = at least one claim was answered and scored,
 * 2 = NOT_CHECKED (nothing answered), 1 = the job itself failed.
 */
import { parseVerdict, type Verdict } from '../classify/free-votes';
import { t12Ask, type T12AskResult } from './t12-attempt';

export interface LabelledClaim {
  id: string;
  claim: string;
  expected: 'TRUE' | 'FALSE';
}

/** Small, stable, uncontroversial. Changing it changes the ruler: bump RULER when you do. */
export const RULER = 't12-claims-v1';
export const CLAIMS: readonly LabelledClaim[] = [
  { id: 'c1', claim: 'Water is made of hydrogen and oxygen.', expected: 'TRUE' },
  { id: 'c2', claim: 'The Sun orbits the Earth.', expected: 'FALSE' },
  { id: 'c3', claim: 'Paris is the capital of France.', expected: 'TRUE' },
  { id: 'c4', claim: 'Spiders are insects with six legs.', expected: 'FALSE' },
  { id: 'c5', claim: 'There are seven days in a week.', expected: 'TRUE' },
  { id: 'c6', claim: 'The Moon is made of cheese.', expected: 'FALSE' },
];

export function promptFor(claim: string): string {
  return [
    'Is the following claim factually true?',
    'Answer with exactly one word, TRUE or FALSE, and nothing else.',
    `Claim: ${claim}`,
  ].join('\n');
}

/**
 * Small models pad their answer. Accept the strict one-word form first; otherwise a leading
 * TRUE/FALSE word only. Anything else is unparseable, never guessed.
 */
export function readLoose(text: string | null): Verdict | null {
  if (text === null) return null;
  const strict = parseVerdict(text);
  if (strict) return strict;
  const m = /^\W*(TRUE|FALSE)\b/i.exec(text.trim());
  return m ? (m[1]!.toUpperCase() as Verdict) : null;
}

export interface ClaimResult {
  id: string;
  expected: 'TRUE' | 'FALSE';
  got: Verdict | null;
  correct: boolean | null;
  outcome: T12AskResult['outcome'];
  host: string | null;
  tried: string[];
}

export interface T12Receipt {
  ticket: 'B21';
  ruler: string;
  at: string;
  commit: string | null;
  runner: string;
  model: string | null;
  answered: number;
  correct: number;
  total: number;
  /** answered / total, or null with nothing to score. Never a 0 that reads as a result. */
  accuracy: number | null;
  hosts: Record<string, number>;
  verdict: 'VERIFIED' | 'NOT_CHECKED';
  results: ClaimResult[];
}

type Ask = (prompt: string) => Promise<T12AskResult>;

export async function runClaimsJob(
  ask: Ask,
  env: Record<string, string | undefined> = process.env,
  claims: readonly LabelledClaim[] = CLAIMS,
): Promise<T12Receipt> {
  const results: ClaimResult[] = [];
  for (const c of claims) {
    let r: T12AskResult;
    try {
      r = await ask(promptFor(c.claim));
    } catch {
      r = { outcome: 'NOT_CHECKED', host: null, tried: [], text: null };
    }
    const got = r.outcome === 'answered' ? readLoose(r.text) : null;
    results.push({
      id: c.id,
      expected: c.expected,
      got,
      correct: got === null ? null : got === c.expected,
      outcome: r.outcome,
      host: r.host,
      tried: r.tried,
    });
    // A 429 means wait; asking the next claim at once would recreate the burst (#1170).
    if (r.outcome === 'rate_limited') break;
  }
  const scored = results.filter((r) => r.correct !== null);
  const hosts: Record<string, number> = {};
  for (const r of results) if (r.outcome === 'answered' && r.host) hosts[r.host] = (hosts[r.host] ?? 0) + 1;
  return {
    ticket: 'B21',
    ruler: RULER,
    at: new Date().toISOString(),
    commit: env.GITHUB_SHA ?? null,
    runner: env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    model: env.T12_LOCAL_MODEL?.trim() || null,
    answered: scored.length,
    correct: scored.filter((r) => r.correct).length,
    total: claims.length,
    accuracy: scored.length === 0 ? null : Math.round((scored.filter((r) => r.correct).length / scored.length) * 1000) / 1000,
    hosts,
    verdict: scored.length > 0 ? 'VERIFIED' : 'NOT_CHECKED',
    results,
  };
}

/** Markdown for the job summary. */
export function receiptMarkdown(r: T12Receipt): string {
  const lines = [
    `## T12 loopback job (${r.ticket}) — ${r.verdict}`,
    '',
    `ruler \`${r.ruler}\` · model \`${r.model ?? 'unset'}\` · runner ${r.runner} · commit \`${r.commit ?? 'n/a'}\``,
    '',
    `answered ${r.answered}/${r.total} · correct ${r.correct}/${r.answered} · accuracy ${r.accuracy ?? 'n/a (nothing scored)'}`,
    `hosts that answered: ${Object.keys(r.hosts).length ? Object.entries(r.hosts).map(([h, n]) => `${h} ×${n}`).join(', ') : 'none'}`,
    '',
    '| claim | expected | got | host | outcome |',
    '|---|---|---|---|---|',
    ...r.results.map((x) => `| ${x.id} | ${x.expected} | ${x.got ?? '—'} | ${x.host ?? '—'} | ${x.outcome} |`),
  ];
  return lines.join('\n');
}

/* istanbul ignore next — the CLI entry the workflow runs. */
if (require.main === module) {
  const timeoutMs = Number(process.env.T12_JOB_TIMEOUT_MS) || 120_000;
  runClaimsJob((prompt) => t12Ask(prompt, { timeoutMs }))
    .then((receipt) => {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:fs').appendFileSync(summary, `${receiptMarkdown(receipt)}\n`);
      }
      process.exit(receipt.verdict === 'VERIFIED' ? 0 : 2);
    })
    .catch((err: unknown) => {
      process.stderr.write(`t12 job failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
