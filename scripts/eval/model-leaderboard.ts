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
// A calibration cell carries its own denominator + a low-N flag, so a "100%"
// off 1 sample can never be read like a "100%" off the full-N set.
interface CalCell {
  pct: number | null;
  n: number; // committed votes this cell is scored on
  low_n: boolean; // true when n < LOW_N_THRESHOLD
}
// Filter provenance — everything needed to reconstruct WHICH rows were scored.
interface FilterProvenance {
  clean_corpus_env: string; // the CLEAN_CORPUS value used (or its default)
  raw_run_size: number; // rows in the raw canary run (before the clean filter)
  scored_rows: number; // rows actually scored (after the clean filter)
  dropped_count: number;
  dropped_rows: Array<{ idx: number; label: string; difficulty: string; claim: string }>;
}
interface Receipt {
  canary_run: string;
  canary_run_generated_at: string;
  canary_run_sha256: string;
  corpus: string | null;
  corpus_sha256: string | null;
  corpus_scope: string;
  n_claims: number;
  filter: FilterProvenance;
}
interface RowReceipt extends Receipt {
  committed_votes: number; // firm TRUE/FALSE votes this provider cast (was "verified_claims")
  total_claims: number; // oracle claims the provider was asked (denominator)
}
interface LeaderboardRow {
  provider: string;
  model: string;
  family: string;
  axes: {
    accuracy_pct: number;
    correct: number;
    committed: number;
    abstains: number;
    errors: number;
    seen: number;
    calibration: {
      easy: CalCell;
      hard: CalCell;
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
      meets_floor: boolean;
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
  coverage_floor_pct: number;
  low_n_threshold: number;
  small_n_caveat: string;
  leaderboard: LeaderboardRow[];
  provisional: LeaderboardRow[];
  unrated: UnratedRow[];
}

// --- Gates / thresholds ------------------------------------------------------
// Coverage is a GATE, not a tie-breaker: a provider must commit a firm vote on
// at least this fraction of the oracle to appear in the MAIN ranked table.
// Below it → "Provisional" (self-selected subset, not comparable to full-N).
const COVERAGE_FLOOR_PCT = 80;
// A calibration/difficulty cell scored on fewer than this many committed votes
// is flagged ⚠ low-N — a "100%" off 1 sample is not a real 100%.
const LOW_N_THRESHOLD = 5;

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

function loadCleanClaims(): {
  file: string | null;
  sha: string | null;
  claims: Set<string>;
  env: string;
} {
  const rel = process.env.CLEAN_CORPUS || 'eval/canary/canary-corpus-v1.1.jsonl';
  const p = path.isAbsolute(rel) ? rel : path.join(REPO_ROOT, rel);
  if (!fs.existsSync(p)) return { file: null, sha: null, claims: new Set(), env: rel };
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
  return { file: rel, sha: sha256(p), claims, env: rel };
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

  // Finding #4: pin the filter into the receipt. Capture exactly which rows the
  // clean-oracle filter dropped, by name, so the 50->47 delta is reconstructable
  // from the receipt alone (never a silent "the numbers just changed").
  const droppedRows = scoringOnClean
    ? run.results
        .filter((r) => !clean.claims.has(r.claim))
        .map((r) => ({ idx: r.idx, label: r.label, difficulty: r.difficulty || 'unknown', claim: r.claim }))
    : [];
  const filterProvenance: FilterProvenance = {
    clean_corpus_env: clean.env,
    raw_run_size: run.results.length,
    scored_rows: nClaims,
    dropped_count: droppedRows.length,
    dropped_rows: droppedRows,
  };

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
    filter: filterProvenance,
  };

  const calCell = (cell?: { committed: number; correct: number }): CalCell => {
    const n = cell ? cell.committed : 0;
    return {
      pct: cell && cell.committed > 0 ? pct(cell.correct, cell.committed) : null,
      n,
      low_n: n > 0 && n < LOW_N_THRESHOLD,
    };
  };

  const buildRow = (a: Acc): LeaderboardRow => {
    const hard = a.byDiff['hard'];
    const easy = a.byDiff['easy'];
    const overconfidence = mean(a.confWhenWrong); // mean confidence WHEN WRONG (lower = better calibrated)
    const confWhenRight = mean(a.confWhenCorrect);
    // hard-row abstain rate: appropriately hedging on the hardest rows is GOOD calibration.
    const hardAbstainRate = hard && hard.seen > 0 ? pct(hard.abstains, hard.seen) : null;
    const committedPct = pct(a.committed, a.seen);
    return {
      provider: a.provider,
      model: a.model,
      family: a.family,
      axes: {
        // --- ACCURACY: correctness on committed votes vs ground truth ---
        accuracy_pct: pct(a.correct, a.committed),
        correct: a.correct,
        committed: a.committed,
        abstains: a.abstains,
        errors: a.errors,
        seen: a.seen,
        // --- CALIBRATION: does it hedge on hard rows + not stay confident when wrong? ---
        // Finding #5: each cell carries its denominator + a low-N flag.
        calibration: {
          easy: calCell(easy),
          hard: calCell(hard),
          hard_abstain_rate_pct: hardAbstainRate,
          mean_confidence_when_wrong: overconfidence, // lower is better
          mean_confidence_when_correct: confWhenRight,
          abstains: a.abstains,
        },
        // --- COVERAGE: how many claims it successfully engaged with ---
        coverage: {
          responded_pct: pct(a.committed + a.abstains, a.seen), // non-error responses
          committed_pct: committedPct, // firm votes
          errors: a.errors,
          error_rate_pct: pct(a.errors, a.seen),
          seen: a.seen,
          meets_floor: committedPct >= COVERAGE_FLOOR_PCT, // Finding #1: the GATE
        },
        // --- LATENCY (optional): responsiveness on real replies ---
        latency: {
          median_ms: median(a.latencies),
          p95_ms: percentile(a.latencies, 95),
          samples: a.latencies.length,
        },
      },
      // Finding #3: report the firm-vote count (committed) with its denominator
      // (total oracle claims), never a bare number that reads like N verified=47.
      receipt: { ...receiptBase, committed_votes: a.committed, total_claims: a.seen },
    };
  };

  // Finding #1: COVERAGE IS A GATE. Only providers that committed a firm vote on
  // >= COVERAGE_FLOOR_PCT of the oracle appear in the MAIN ranked table. Providers
  // below the floor (e.g. cerebras 21.3%) go to a SEPARATE "Provisional" section —
  // never interleaved with fully-covered providers, so nobody can win by
  // abstaining/erroring on the hard rows.
  const allRatedRows = rated.map(buildRow);
  const byAccuracy = (x: LeaderboardRow, y: LeaderboardRow) =>
    y.axes.accuracy_pct - x.axes.accuracy_pct ||
    y.axes.coverage.committed_pct - x.axes.coverage.committed_pct;
  const leaderboard = allRatedRows.filter((r) => r.axes.coverage.meets_floor).sort(byAccuracy);
  const provisional = allRatedRows.filter((r) => !r.axes.coverage.meets_floor).sort(byAccuracy);

  const unratedNotes: UnratedRow[] = unrated
    .map((a) => ({
      provider: a.provider,
      model: a.model,
      family: a.family,
      status: 'UNRATED — no verified engagement',
      reason: `${a.errors}/${a.seen} calls errored (429/quota/timeout); 0 real verdicts. Per LAW 1, no score is fabricated.`,
      receipt: { ...receiptBase, committed_votes: 0, total_claims: a.seen },
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
    coverage_floor_pct: COVERAGE_FLOOR_PCT,
    low_n_threshold: LOW_N_THRESHOLD,
    small_n_caveat: `N=${nClaims} known-answer claims — directional, not a benchmark leaderboard. Treat as an earned snapshot from one verified run, not a universal ranking.`,
    leaderboard,
    provisional,
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
  const line = (r: LeaderboardRow) => {
    const x = r.axes;
    // Finding #2: accuracy ALWAYS shown with its committed denominator + the
    // abstain/error tail — never a bare percentage.
    const acc = `${x.accuracy_pct}% (${x.correct}/${x.committed} committed · ${x.abstains} abst · ${x.errors} err of ${x.seen})`;
    return `${r.provider.padEnd(11)} | ${acc.padEnd(48)} | cov ${String(x.coverage.committed_pct).padStart(5)}% | med ${String(
      x.latency.median_ms ?? '—',
    ).padStart(5)}ms | conf.wrong ${x.calibration.mean_confidence_when_wrong ?? '—'}`;
  };
  console.log('\n=== EARNED MODEL LEADERBOARD ===');
  console.log(`scored on: ${receiptBase.corpus_scope}  N=${nClaims} claims  (raw run ${filterProvenance.raw_run_size} - ${filterProvenance.dropped_count} dropped)`);
  console.log(`run: ${receiptBase.canary_run}  (${receiptBase.canary_run_generated_at})`);
  console.log(`\nMAIN (coverage >= ${COVERAGE_FLOOR_PCT}% committed):`);
  for (const r of leaderboard) console.log('  ' + line(r));
  if (provisional.length) {
    console.log(`\nPROVISIONAL (coverage < ${COVERAGE_FLOOR_PCT}% — self-selected subset, NOT ranked with full-N):`);
    for (const r of provisional) console.log('  ' + line(r));
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

  // Finding #2: accuracy is ALWAYS rendered with its committed denominator AND
  // the abstain/error tail — never a bare percentage that hides the subset.
  const accWithTail = (a: LeaderboardRow['axes']) =>
    `**${a.accuracy_pct}%** (${a.correct}/${a.committed} committed · ${a.abstains} abstain · ${a.errors} err of ${a.seen})`;

  // Finding #5: a calibration cell shows its denominator + a ⚠ when N is low.
  // n = committed votes the cell was scored on; the pct is correct/n, so the
  // denominator is n (rendered as "%pct (n)"), and ⚠ flags n < LOW_N_THRESHOLD.
  const renderCal = (c: CalCell) => (c.pct === null ? '—' : `${c.pct}% (n=${c.n})${c.low_n ? ' ⚠' : ''}`);

  const rowMd = (p: LeaderboardRow) => {
    const a = p.axes;
    // Finding #3: the last column is committed/total (firm votes / oracle N),
    // NOT a mislabeled "N verified" that contradicts the header.
    return `| ${p.provider} | \`${p.model}\` | ${p.family} | ${accWithTail(a)} | ${renderCal(
      a.calibration.easy,
    )} / ${renderCal(a.calibration.hard)} | ${fmt(a.calibration.mean_confidence_when_wrong)} | ${a.coverage.committed_pct}% (${a.committed}/${a.coverage.seen}) | ${a.coverage.errors} | ${fmt(
      a.latency.median_ms,
    )} / ${fmt(a.latency.p95_ms)} | ${p.receipt.committed_votes}/${p.receipt.total_claims} |`;
  };

  const headerRow =
    '| provider | model | family | accuracy (committed · tail) | calib: easy / hard acc (N) | conf-when-wrong ↓ | coverage (committed) | errors | latency med/p95 ms | committed/total |\n' +
    '|---|---|---|---|---|---|---|---|---|---|';

  const rows = out.leaderboard.map(rowMd).join('\n');

  const provisionalRows = out.provisional.length
    ? out.provisional.map(rowMd).join('\n')
    : '| — | — | — | (none — every rated provider met the coverage floor) | — | — | — | — | — | — |';

  const unratedRows = out.unrated.length
    ? out.unrated.map((u) => `| ${u.provider} | \`${u.model}\` | ${u.status} | ${u.reason} |`).join('\n')
    : '| — | — | (all quorum members voted) | — |';

  const droppedList = r.filter.dropped_rows.length
    ? r.filter.dropped_rows
        .map((d) => `  - idx ${d.idx} [${d.label}/${d.difficulty}]: "${d.claim}"`)
        .join('\n')
    : '  - (none — scored on the full raw run)';

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
| corpus (oracle N) | \`${r.corpus}\` |
| corpus scope | ${r.corpus_scope} |
| corpus sha256 | ${r.corpus_sha256 ? `\`${r.corpus_sha256}\`` : '—'} |
| \`CLEAN_CORPUS\` used | \`${r.filter.clean_corpus_env}\` |
| raw run size → scored | ${r.filter.raw_run_size} → ${r.filter.scored_rows} (**${r.filter.dropped_count} dropped**) |
| **oracle N (claims asked)** | **${r.n_claims}** |

**Rows dropped by the clean-oracle filter (${r.filter.dropped_count}), named for reproducibility:**
${droppedList}

> **Small-N caveat.** ${out.small_n_caveat}
> Per-provider **committed** votes vary (the oracle N=${r.n_claims}, but a provider only gets scored on the
> claims it actually voted on) — every row below shows both.

## Leaderboard — MAIN (coverage ≥ ${out.coverage_floor_pct}% committed; axes kept SEPARATE)
Only providers that committed a firm TRUE/FALSE vote on **≥ ${out.coverage_floor_pct}% of the oracle** appear here.
Coverage is a **gate, not a tie-breaker** — a provider cannot rank by abstaining/erroring on the hard rows.
Providers below the floor are in the **Provisional** section and are *not* comparable to full-coverage rows.
Accuracy is always shown with its committed denominator and the abstain/error tail. Calibration cells show
their own N; ⚠ = fewer than ${out.low_n_threshold} committed votes (a "100%" off 1 sample is not a real 100%).

${headerRow}
${rows}

## Provisional — insufficient coverage to rank (coverage < ${out.coverage_floor_pct}% committed)
> These providers voted on too small a self-selected subset of the oracle to be ranked against the fully-covered
> providers above. A high accuracy here is on a **survivor subset** (the claims it did not error/abstain on),
> not the full oracle — do **not** read it as "beats" a MAIN-table provider.

${headerRow}
${provisionalRows}

## Unrated providers (LAW 1 — no verified engagement, so no score)
| provider | model | status | reason |
|---|---|---|---|
${unratedRows}

## Axis definitions
- **accuracy_pct** — of the claims where the provider committed a firm TRUE/FALSE verdict, the fraction that
  matched the known label. Always shown as \`% (correct/committed · abstain · err of seen)\` so the
  self-selected denominator is visible. Abstentions and errors are excluded from the ratio (they can't be
  right or wrong) but are always reported alongside it.
- **coverage GATE** — \`committed%\` = firm votes / oracle claims seen. A provider must clear
  **${out.coverage_floor_pct}%** to appear in the MAIN table; below it it's Provisional. \`errors\` = 429/quota/timeout.
- **calibration** — two facets: (a) *easy vs hard accuracy*, each shown with its N and a ⚠ low-N flag
  (< ${out.low_n_threshold} committed votes), so a 1/1 "100%" is never read like a full-N 100%; and
  (b) *mean confidence when wrong* — a well-calibrated model is **less** confident on the answers it gets wrong.
- **latency** — median / p95 ms on real (non-error) replies. Optional axis; captured because the run logged it.
- **committed/total** — firm TRUE/FALSE votes the provider cast / oracle claims it was asked (the header's N).

## Quorum manifest (models under test this run)
| provider | model | family |
|---|---|---|
${out.quorum_manifest.map((q) => `| ${q.name} | \`${q.model}\` | ${q.family} |`).join('\n')}

## How to reproduce
\`\`\`bash
# 1. (re)generate the verified verdicts — real cross-LLM quorum, live keys:
npx ts-node scripts/eval/canary-f1.ts
# 2. re-score into this leaderboard (pure, deterministic, no LLM calls).
#    Pin the exact inputs so the numbers below are fully reconstructable:
CANARY_RAW='${r.canary_run}' \\
CLEAN_CORPUS='${r.filter.clean_corpus_env}' \\
  npx ts-node scripts/eval/model-leaderboard.ts
# The clean-oracle filter scores ${r.filter.scored_rows} of the raw run's ${r.filter.raw_run_size} rows
# (drops ${r.filter.dropped_count}: idx ${r.filter.dropped_rows.map((d) => d.idx).join(', ') || '—'} — see the Receipt section for the named claims).
\`\`\`

_Generated by \`scripts/eval/model-leaderboard.ts\` — a deterministic re-scoring of already-verified verdicts._
`;
}

main();
