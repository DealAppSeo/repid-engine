/**
 * EARNED MODEL LEADERBOARD — provider ratings from VERIFIED fact-checks.
 *
 * WHAT THIS IS: the first *earned* model leaderboard in repid-engine. Every
 * rating here is derived from a real cross-LLM fact-check quorum run (the canary
 * F1 harness, `scripts/eval/canary-f1.ts`) whose per-provider, per-claim verdicts
 * were logged against a known-answer oracle corpus. It is the honest alternative
 * to "which LLM is best" listicles:
 *
 *   LAW 1 (a rating exists only from a verified engagement): a provider gets a
 *          rating ONLY if it actually voted on real claims. A provider that
 *          429'd/errored the whole run gets a COVERAGE NOTE, never a score.
 *   LAW 2 (anchored to ground truth): every axis is scored against the corpus's
 *          known TRUE/FALSE labels, not against other models' opinions.
 *   LAW 3 (every rating carries its receipt): each row records which canary run
 *          it came from, how many claims it was verified on, and the corpus
 *          version + hash — so the rating is auditable end-to-end.
 *
 * IT DOES NOT collapse the axes into one number. "Best" is multi-dimensional:
 * accuracy, calibration, coverage, and latency are kept separate on purpose.
 *
 * DATA SOURCE: this reads the raw JSON emitted by `canary-f1.ts` (default:
 * reports/2026-07-07/canary-f1-raw-*.json). It does NOT call any LLM — it is a
 * pure, deterministic re-scoring of already-verified verdicts. Small N (the
 * canary corpus is ~47-50 claims): stated on every artifact.
 *
 * Run (from repo root):
 *   npx ts-node scripts/eval/model-leaderboard.ts
 * Optional env:
 *   CANARY_RAW=reports/2026-07-07/canary-f1-raw-....json   pin a specific run
 *   CLEAN_CORPUS=eval/canary/canary-corpus-v1.1.jsonl      clean-oracle subset
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types mirroring the canary-f1 raw JSON (scripts/eval/canary-f1.ts writer).
// ---------------------------------------------------------------------------
interface RawVerdict {
  provider: string;
  verdict: string; // 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'ERROR' | ...
  confidence: number;
  error?: string;
  latency_ms: number;
}
interface RawResult {
  idx: number;
  claim: string;
  label: 'TRUE' | 'FALSE';
  domain: string;
  difficulty: string;
  verdicts: RawVerdict[];
}
interface RawRun {
  generated_at: string;
  corpus_size: number;
  quorum: Array<{ name: string; model: string; family: string }>;
  providers_that_voted: string[];
  results: RawResult[];
}

// --- Output shapes (single source of truth for the JSON + markdown) ---------
interface Receipt {
  canary_run: string;
  canary_run_generated_at: string;
  canary_run_sha256: string;
  corpus: string | null;
  corpus_sha256: string | null;
  corpus_scope: string;
  n_claims: number;
}
interface RowReceipt extends Receipt {
  verified_claims: number;
}
interface LeaderboardRow {
  provider: string;
  model: string;
  family: string;
  axes: {
    accuracy_pct: number;
    correct: number;
    committed: number;
    calibration: {
      easy_accuracy_pct: number | null;
      hard_accuracy_pct: number | null;
      hard_abstain_rate_pct: number | null;
      mean_confidence_when_wrong: number | null;
      mean_confidence_when_correct: number | null;
      abstains: number;
    };
    coverage: {
      responded_pct: number;
      committed_pct: number;
      errors: number;
      error_rate_pct: number;
      seen: number;
    };
    latency: { median_ms: number | null; p95_ms: number | null; samples: number };
  };
  receipt: RowReceipt;
}
interface UnratedRow {
  provider: string;
  model: string;
  family: string;
  status: string;
  reason: string;
  receipt: RowReceipt;
}
interface LeaderboardOut {
  title: string;
  generated_at: string;
  laws: Record<string, string>;
  receipt: Receipt;
  quorum_manifest: Array<{ name: string; model: string; family: string }>;
  n_claims: number;
  small_n_caveat: string;
  leaderboard: LeaderboardRow[];
  unrated: UnratedRow[];
}

// A committed verdict is a real TRUE/FALSE vote. Everything else (UNCERTAIN,
// ERROR, empty) is NOT a commitment — we split abstentions from errors.
type Committed = 'TRUE' | 'FALSE';
function classify(v: RawVerdict): 'committed' | 'abstain' | 'error' {
  if (v.error || v.verdict === 'ERROR') return 'error';
  if (v.verdict === 'TRUE' || v.verdict === 'FALSE') return 'committed';
  // UNCERTAIN / anything else the provider returned that isn't a firm vote.
  return 'abstain';
}

// ---------------------------------------------------------------------------
// Locate inputs.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, '../..');

function findRawRun(): string {
  const pinned = process.env.CANARY_RAW;
  if (pinned) {
    const p = path.isAbsolute(pinned) ? pinned : path.join(REPO_ROOT, pinned);
    if (!fs.existsSync(p)) {
      console.error(`[leaderboard] FATAL: CANARY_RAW=${pinned} not found at ${p}`);
      process.exit(2);
    }
    return p;
  }
  const dir = path.join(REPO_ROOT, 'reports/2026-07-07');
  const candidates = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^canary-f1-raw-.*\.json$/.test(f))
        .map((f) => path.join(dir, f))
        .sort() // ISO timestamps sort lexicographically -> newest last
    : [];
  if (candidates.length === 0) {
    console.error(
      '[leaderboard] FATAL: no canary raw run found under reports/2026-07-07/ ' +
        '(canary-f1-raw-*.json). Run scripts/eval/canary-f1.ts first, or set CANARY_RAW.',
    );
    process.exit(2);
  }
  return candidates[candidates.length - 1]!;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadCleanClaims(): { file: string | null; sha: string | null; claims: Set<string> } {
  const rel = process.env.CLEAN_CORPUS || 'eval/canary/canary-corpus-v1.1.jsonl';
  const p = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) return { file: null, sha: null, claims: new Set() };
  const claims = new Set<string>();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      claims.add((JSON.parse(t) as { claim: string }).claim);
    } catch {
      /* skip malformed */
    }
  }
  return { file: rel, sha: sha256(p), claims };
}

// ---------------------------------------------------------------------------
// Per-provider accumulator + axis math.
// ---------------------------------------------------------------------------
interface Acc {
  provider: string;
  model: string;
  family: string;
  seen: number; // claims the provider was asked (should equal corpus size)
  errors: number; // ERROR / no-response
  abstains: number; // UNCERTAIN / non-committal
  committed: number; // firm TRUE/FALSE votes
  correct: number; // committed votes that matched the label
  // difficulty split (committed only)
  byDiff: Record<string, { committed: number; correct: number; abstains: number; seen: number }>;
  // calibration signals
  confWhenCorrect: number[];
  confWhenWrong: number[];
  // latency (successful, non-error responses only — abstain replies still had a latency)
  latencies: number[];
}
function newAcc(provider: string, model: string, family: string): Acc {
  return {
    provider,
    model,
    family,
    seen: 0,
    errors: 0,
    abstains: 0,
    committed: 0,
    correct: 0,
    byDiff: {},
    confWhenCorrect: [],
    confWhenWrong: [],
    latencies: [],
  };
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : +((100 * n) / d).toFixed(1);
}
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}
function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  const rawPath = findRawRun();
  const rawSha = sha256(rawPath);
  const run = JSON.parse(fs.readFileSync(rawPath, 'utf8')) as RawRun;
  const clean = loadCleanClaims();

  // Score on the CLEAN oracle subset when available (drops the contested rows
  // pruned in v1.1), else fall back to every result in the run.
  const scoringOnClean = clean.claims.size > 0;
  const rows = scoringOnClean
    ? run.results.filter((r) => clean.claims.has(r.claim))
    : run.results;
  const nClaims = rows.length;

  // model/family lookup from the quorum manifest
  const meta = new Map(run.quorum.map((q) => [q.name, q]));

  // Every provider that appears in ANY verdict — including ones that only errored.
  const allProviders = new Set<string>();
  for (const r of rows) for (const v of r.verdicts) allProviders.add(v.provider);

  const accs = new Map<string, Acc>();
  for (const p of allProviders) {
    const m = meta.get(p);
    accs.set(p, newAcc(p, m?.model ?? 'unknown', m?.family ?? 'unknown'));
  }

  for (const r of rows) {
    const label = r.label as Committed;
    const diff = r.difficulty || 'unknown';
    for (const v of r.verdicts) {
      const a = accs.get(v.provider)!;
      a.seen++;
      (a.byDiff[diff] ??= { committed: 0, correct: 0, abstains: 0, seen: 0 }).seen++;
      const kind = classify(v);
      if (kind === 'error') {
        a.errors++;
        continue;
      }
      if (kind === 'abstain') {
        a.abstains++;
        a.byDiff[diff]!.abstains++;
        if (typeof v.latency_ms === 'number' && v.latency_ms > 0) a.latencies.push(v.latency_ms);
        continue;
      }
      // committed
      a.committed++;
      a.byDiff[diff]!.committed++;
      const right = (v.verdict as Committed) === label;
      if (right) {
        a.correct++;
        a.byDiff[diff]!.correct++;
        a.confWhenCorrect.push(v.confidence);
      } else {
        a.confWhenWrong.push(v.confidence);
      }
      if (typeof v.latency_ms === 'number' && v.latency_ms > 0) a.latencies.push(v.latency_ms);
    }
  }

  // Partition: RATED (voted on >=1 real claim) vs UNRATED (all-error).
  const rated: Acc[] = [];
  const unrated: Acc[] = [];
  for (const a of accs.values()) {
    if (a.committed + a.abstains > 0) rated.push(a);
    else unrated.push(a);
  }

  // Build the per-provider leaderboard rows (axes kept SEPARATE — no blended score).
  const receiptBase: Receipt = {
    canary_run: path.relative(REPO_ROOT, rawPath).replace(/\\/g, '/'),
    canary_run_generated_at: run.generated_at,
    canary_run_sha256: rawSha,
    corpus: scoringOnClean ? clean.file : 'eval/canary/canary-corpus-v1.jsonl (full run corpus)',
    corpus_sha256: scoringOnClean ? clean.sha : null,
    corpus_scope: scoringOnClean ? 'clean-oracle (v1.1)' : 'full-run (v1)',
    n_claims: nClaims,
  };

  const leaderboard: LeaderboardRow[] = rated
    .map((a) => {
      const hard = a.byDiff['hard'];
      const easy = a.byDiff['easy'];
      const hardAcc = hard && hard.committed > 0 ? pct(hard.correct, hard.committed) : null;
      const easyAcc = easy && easy.committed > 0 ? pct(easy.correct, easy.committed) : null;
      const overconfidence = mean(a.confWhenWrong); // mean confidence WHEN WRONG (lower = better calibrated)
      const confWhenRight = mean(a.confWhenCorrect);
      // hard-row abstain rate: appropriately hedging on the hardest rows is GOOD calibration.
      const hardAbstainRate = hard && hard.seen > 0 ? pct(hard.abstains, hard.seen) : null;
      return {
        provider: a.provider,
        model: a.model,
        family: a.family,
        axes: {
          // --- ACCURACY: correctness on committed votes vs ground truth ---
          accuracy_pct: pct(a.correct, a.committed),
          correct: a.correct,
          committed: a.committed,
          // --- CALIBRATION: does it hedge on hard rows + not stay confident when wrong? ---
          calibration: {
            easy_accuracy_pct: easyAcc,
            hard_accuracy_pct: hardAcc,
            hard_abstain_rate_pct: hardAbstainRate,
            mean_confidence_when_wrong: overconfidence, // lower is better
            mean_confidence_when_correct: confWhenRight,
            abstains: a.abstains,
          },
          // --- COVERAGE: how many claims it successfully engaged with ---
          coverage: {
            responded_pct: pct(a.committed + a.abstains, a.seen), // non-error responses
            committed_pct: pct(a.committed, a.seen), // firm votes
            errors: a.errors,
            error_rate_pct: pct(a.errors, a.seen),
            seen: a.seen,
          },
          // --- LATENCY (optional): responsiveness on real replies ---
          latency: {
            median_ms: median(a.latencies),
            p95_ms: percentile(a.latencies, 95),
            samples: a.latencies.length,
          },
        },
        receipt: { ...receiptBase, verified_claims: a.committed },
      };
    })
    // Order by accuracy, then coverage — but the axes stay independent in the row.
    .sort(
      (x, y) =>
        y.axes.accuracy_pct - x.axes.accuracy_pct ||
        y.axes.coverage.committed_pct - x.axes.coverage.committed_pct,
    );

  const unratedNotes: UnratedRow[] = unrated
    .map((a) => ({
      provider: a.provider,
      model: a.model,
      family: a.family,
      status: 'UNRATED — no verified engagement',
      reason: `${a.errors}/${a.seen} calls errored (429/quota/timeout); 0 real verdicts. Per LAW 1, no score is fabricated.`,
      receipt: { ...receiptBase, verified_claims: 0 },
    }))
    .sort((x, y) => x.provider.localeCompare(y.provider));

  const out: LeaderboardOut = {
    title: 'EARNED MODEL LEADERBOARD — provider ratings from verified canary fact-checks',
    generated_at: new Date().toISOString(),
    laws: {
      law1: 'a rating exists only from a verified engagement (a provider must actually vote)',
      law2: 'anchored to ground truth (scored against the corpus known TRUE/FALSE labels)',
      law3: 'every rating carries its receipt (run + N verified claims + corpus hash)',
    },
    receipt: receiptBase,
    quorum_manifest: run.quorum,
    n_claims: nClaims,
    small_n_caveat: `N=${nClaims} known-answer claims — directional, not a benchmark leaderboard. Treat as an earned snapshot from one verified run, not a universal ranking.`,
    leaderboard,
    unrated: unratedNotes,
  };

  // ---- write JSON + markdown ----
  const outDir = path.join(REPO_ROOT, 'eval/leaderboard');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'earned-model-leaderboard.json');
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

  const reportDir = path.join(REPO_ROOT, 'reports/2026-07-08');
  fs.mkdirSync(reportDir, { recursive: true });
  const mdPath = path.join(reportDir, 'EARNED_MODEL_LEADERBOARD.md');
  fs.writeFileSync(mdPath, renderMarkdown(out));

  // ---- console summary ----
  console.log('\n=== EARNED MODEL LEADERBOARD ===');
  console.log(`scored on: ${receiptBase.corpus_scope}  N=${nClaims} verified claims`);
  console.log(`run: ${receiptBase.canary_run}  (${receiptBase.canary_run_generated_at})`);
  console.log('\nprovider           | acc%  (correct/committed) | coverage%(committed) | err | med.ms | conf.wrong');
  for (const r of leaderboard) {
    const x = r.axes;
    console.log(
      `${r.provider.padEnd(18)} | ${String(x.accuracy_pct).padStart(5)}  (${x.correct}/${x.committed})`.padEnd(46) +
        `| ${String(x.coverage.committed_pct).padStart(5)}%             | ${String(x.coverage.errors).padStart(3)} | ${String(
          x.latency.median_ms ?? '—',
        ).padStart(6)} | ${x.calibration.mean_confidence_when_wrong ?? '—'}`,
    );
  }
  if (unratedNotes.length) {
    console.log('\nUNRATED (no verified engagement — coverage note, NOT a score):');
    for (const u of unratedNotes) console.log(`  ${u.provider.padEnd(12)} ${u.reason}`);
  }
  console.log(`\nwrote JSON -> ${path.relative(REPO_ROOT, jsonPath).replace(/\\/g, '/')}`);
  console.log(`wrote MD   -> ${path.relative(REPO_ROOT, mdPath).replace(/\\/g, '/')}`);
}

// ---------------------------------------------------------------------------
function renderMarkdown(out: LeaderboardOut): string {
  const r = out.receipt;
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

  const rows = out.leaderboard
    .map((p) => {
      const a = p.axes;
      return `| ${p.provider} | \`${p.model}\` | ${p.family} | **${a.accuracy_pct}%** (${a.correct}/${a.committed}) | ${fmt(
        a.calibration.easy_accuracy_pct,
      )}% / ${fmt(a.calibration.hard_accuracy_pct)}% | ${fmt(a.calibration.mean_confidence_when_wrong)} | ${a.coverage.committed_pct}% (${a.committed}/${a.coverage.seen}) | ${a.coverage.errors} | ${fmt(
        a.latency.median_ms,
      )} / ${fmt(a.latency.p95_ms)} | ${p.receipt.verified_claims} |`;
    })
    .join('\n');

  const unratedRows = out.unrated.length
    ? out.unrated.map((u) => `| ${u.provider} | \`${u.model}\` | ${u.status} | ${u.reason} |`).join('\n')
    : '| — | — | (all quorum members voted) | — |';

  return `# ${out.title}

> **These ratings are EARNED from ${out.n_claims} verified fact-checks, each carrying its receipt** — the honest
> alternative to "which LLM is best" listicles. No vibes, no vendor benchmarks: every number below comes
> from a real cross-LLM quorum run whose per-provider, per-claim verdicts were scored against a
> known-answer oracle.

## The participant-rating laws this demonstrates
1. **A rating exists only from a verified engagement.** A provider is rated only if it actually voted on
   real claims. A provider that 429'd/errored the entire run gets a **coverage note, never a fabricated score**.
2. **Anchored to ground truth.** Every axis is scored against the corpus's known TRUE/FALSE labels — not
   against other models' opinions.
3. **Every rating carries its receipt.** Each row records the canary run, how many claims it was verified on,
   and the corpus version + hash. Fully auditable.

## Receipt (applies to every row)
| field | value |
|---|---|
| canary run | \`${r.canary_run}\` |
| run generated at | ${r.canary_run_generated_at} |
| run sha256 | \`${r.canary_run_sha256}\` |
| corpus | \`${r.corpus}\` |
| corpus scope | ${r.corpus_scope} |
| corpus sha256 | ${r.corpus_sha256 ? `\`${r.corpus_sha256}\`` : '—'} |
| **N verified claims** | **${r.n_claims}** |

> **Small-N caveat.** ${out.small_n_caveat}

## Leaderboard (axes kept SEPARATE — "best" is multi-dimensional, not one number)
Accuracy is correctness on the claims a provider actually committed a TRUE/FALSE vote on. Calibration shows
easy-vs-hard accuracy and *mean confidence when wrong* (lower = better calibrated — it isn't loudly confident
about mistakes). Coverage is how many claims it successfully engaged (committed a firm vote on) vs errored.

| provider | model | family | accuracy | calib: easy / hard acc | conf-when-wrong ↓ | coverage (committed) | errors | latency med/p95 ms | N verified |
|---|---|---|---|---|---|---|---|---|---|
${rows}

## Unrated providers (LAW 1 — no verified engagement, so no score)
| provider | model | status | reason |
|---|---|---|---|
${unratedRows}

## Axis definitions
- **accuracy_pct** — of the claims where the provider committed a firm TRUE/FALSE verdict, the fraction that
  matched the known label. Abstentions and errors are excluded (they can't be right or wrong).
- **calibration** — two facets: (a) *easy vs hard accuracy* (does it degrade gracefully on the hard rows?),
  and (b) *mean confidence when wrong* — a well-calibrated model is **less** confident on the answers it gets
  wrong. Also tracks hard-row abstain rate: hedging on the hardest rows is good calibration, not a failure.
- **coverage** — \`committed%\` = firm votes / claims seen; \`errors\` = 429/quota/timeout responses. A high
  error rate caps how much its accuracy can be trusted (small denominator).
- **latency** — median / p95 ms on real (non-error) replies. Optional axis; captured because the run logged it.

## Quorum manifest (models under test this run)
| provider | model | family |
|---|---|---|
${out.quorum_manifest.map((q) => `| ${q.name} | \`${q.model}\` | ${q.family} |`).join('\n')}

## How to reproduce
\`\`\`bash
# 1. (re)generate the verified verdicts — real cross-LLM quorum, live keys:
npx ts-node scripts/eval/canary-f1.ts
# 2. re-score into this leaderboard (pure, deterministic, no LLM calls):
npx ts-node scripts/eval/model-leaderboard.ts
\`\`\`

_Generated by \`scripts/eval/model-leaderboard.ts\` — a deterministic re-scoring of already-verified verdicts._
`;
}

main();
