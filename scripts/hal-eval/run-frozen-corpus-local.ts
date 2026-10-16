/**
 * run-frozen-corpus-local.ts — LEG 2: measure HAL against the frozen corpus
 * IN-PROCESS, with no HTTP and therefore no public rate cap.
 *
 * WHY THIS AND NOT THE HTTP RUNNER. scripts/hal-eval/run-frozen-corpus.mjs goes
 * through POST /api/v1/hal/evaluate, which is capped at 10 requests per 24h per
 * IP (HAL_PUBLIC_RATE_LIMIT). A 99-row holdout cannot complete through it —
 * three attempts today produced 98/99, 15/15 and 6/6 HTTP 429s. That cap is
 * correct for anonymous traffic and useless for measurement.
 *
 * Calling halService.evaluate() directly removes the transport entirely. Same
 * scoring code the deployed engine runs, same providers, no network in between.
 *
 * SECRET HANDLING. Provider keys are loaded from .env.master by dotenv INSIDE
 * this process and never leave it. No shell export, no echo, no interpolation
 * into a command line. Earlier today a bare `export` in a shell pipeline printed
 * the whole environment and leaked two live credentials; this path cannot do
 * that because the values never reach a shell at all.
 *
 * THE TWO GATES, same as the HTTP runner:
 *   HASH     refuses to measure a corpus that does not match MANIFEST.json
 *   COVERAGE refuses to print an F1 below 80% scored — a transport or provider
 *            failure must never be reportable as a quality result
 *
 * THE HOLDOUT IS PRIVATE (S60, 2026-10-07). `--split holdout` (the default) reads the private
 * rotating holdout (scripts/eval/holdout.ts) and exits 2 NOT_CHECKED when no private source is
 * reachable, never falling back to a public set. `--corpus` names a public set and applies only to
 * `--split retired-holdout|train|all`; those have been public since July, and every number on
 * them carries `holdout: "retired-public"` plus a printed line saying it is not a holdout score.
 * A private run writes counts only (per-item ids and truth stay out of git), records the checker
 * families that answered each item in eval/holdout/manifest.jsonl, and is `incomplete` when any
 * item was answered by fewer than two families.
 *
 * BUDGET MODE (2026-10-14). `--max-calls N` caps outbound provider calls, because the free-tier
 * quota a run spends is the one live HAL and the swarm also spend. Every non-Supabase `fetch` this
 * process makes is counted (provider calls, 429 retries, the prefilter and catalog lookups all hit
 * the same quotas). It forces concurrency 1 so each row's calls are attributable, and stops before a
 * row once `calls so far + the costliest row so far` would pass N; the first row always runs. Rows
 * are taken in evalOrder() (class-interleaved sha256(id)), and so is `--limit`, so a capped run is
 * the first k rows of a content-defined order and its ruler says "first k of N".
 *
 * NOT_CHECKED (scoring v2-no-agreement-is-not-checked, 2026-10-15). An abstain, an extractor
 * fallback, an error, or a VETO NO CHECKER VOTED FALSE FOR is HAL not judging the row. The smoke on
 * 2026-10-15 scored a TP from two UNCERTAIN votes at halScore 0.5; under v1 that read as a catch.
 * Scoring v3 (2026-10-16) adds a row decided on fewer than two model families (HAL held it, it did not
 * judge it). Every headline number in the output is the current SCORING, checked rows only. The old all-scored-rows numbers
 * (abstain counted as a pass) sit under `legacy_all_scored` with their own scoring name. Numbers
 * on different scorings are never compared.
 *
 * ISOLATION (2026-10-15). By default nothing reaches production: see measure-isolation.ts, imported
 * first. --write-prod restores the live write paths, for when a run is MEANT to be production traffic.
 *
 * Usage:
 *   npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts [--split holdout|retired-holdout|train|all]
 *        [--corpus rigorous-v1] [--limit N] [--max-calls N] [--concurrency 4] [--write-prod]
 */
// FIRST, before dotenv and before anything that reads config at import time: no prod writes unless --write-prod.
import { ISOLATION, isolationBanner } from './measure-isolation';
import 'dotenv/config';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { isHallucination, confusionMatrix, prf1, rocAuc, perClass, evalOrder, isNotCheckedV3, isNoAgreementVeto, isUnderQuorum, SCORING } from './metrics';
import {
  exitCodeFor,
  familiesRecord,
  HoldoutNotCheckedError,
  holdoutRuler,
  loadPrivateHoldout,
  recordCheckerPairs,
} from '../eval/holdout';
import { retiredLine, retiredStamp } from '../eval/retired-holdout';

// Load the key inventory in-process. Values are never printed, never exported,
// never placed on a command line.
const MASTER = process.env.ENV_MASTER_PATH || 'C:/Users/Cash4/repos/.env.master';
if (fs.existsSync(MASTER)) dotenv.config({ path: MASTER });

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json');

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : d;
};
const corpusName = flag('corpus', 'rigorous-v1');
const split = flag('split', 'holdout');
const limit = Number(flag('limit', '0'));
const maxCalls = Number(flag('max-calls', '0'));
const concurrency = maxCalls > 0 ? 1 : Math.max(1, Number(flag('concurrency', '4')));
const MIN_COVERAGE = Number(process.env.HAL_EVAL_MIN_COVERAGE ?? '0.8');
const PUBLIC_SPLITS = ['retired-holdout', 'train', 'all'];
const isPrivate = split === 'holdout';
if (!isPrivate && !PUBLIC_SPLITS.includes(split)) {
  console.error(`--split must be holdout (private) or one of ${PUBLIC_SPLITS.join(', ')}`);
  process.exit(1);
}

interface CorpusEntry {
  name: string;
  path: string;
  sha256: string;
  answer_mode: string;
}
interface Row {
  id: string;
  prompt: string;
  candidate_answer: string;
  label: string;
  split: string;
}
let entry: CorpusEntry | undefined;
let hashed = '';
let RULER = '';
let rows: Row[] = [];
// The output file stem: the public corpus name, or 'private-holdout'.
let stem = 'private-holdout';

if (!isPrivate) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { corpora: CorpusEntry[] };
  entry = manifest.corpora.find((c) => c.name === corpusName);
  if (!entry) {
    console.error(`No corpus "${corpusName}" in MANIFEST.json`);
    process.exit(2);
  }

  // ── HASH GATE ─────────────────────────────────────────────────────────────
  hashed = execFileSync(
    'node',
    [path.join(ROOT, 'scripts', 'corpus', 'hash-corpus.mjs'), path.join(ROOT, entry!.path)],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .pop()!
    .trim();

  if (hashed !== entry!.sha256) {
    console.error('REFUSING TO MEASURE — corpus hash mismatch.');
    console.error(`  manifest: ${entry!.sha256}`);
    console.error(`  on disk : ${hashed}`);
    console.error('  Any F1 taken now would be unattributable to a known ruler.');
    process.exit(1);
  }
  RULER = `${entry!.name}@${hashed.slice(0, 12)}`;
  stem = entry!.name;

  rows = fs
    .readFileSync(path.join(ROOT, entry!.path), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row);
  // 'retired-holdout' is the old public holdout split, kept for regression; it is not a holdout.
  if (split === 'retired-holdout') rows = rows.filter((r) => r.split === 'holdout');
  else if (split !== 'all') rows = rows.filter((r) => r.split === split);
}

interface Scored {
  id: string;
  truth: string;
  verdict?: string;
  halScore?: number;
  mode?: string;
  familiesUsed?: number;
  families?: string[];
  /** Each checker's verdict, counted (TRUE / FALSE / UNCERTAIN / ERROR). Scoring v2 reads it. */
  votes?: Record<string, number>;
  /** Wall-clock ms of this row's halService.evaluate (in-process; provider waits dominate). */
  ms?: number;
  /** Each checker's answer: provider, verdict, confidence (0-100), latency, and a failure reason when it failed. */
  providers?: Array<{ p: string; v: string; c?: number; ms?: number; e?: string }>;
  error?: string;
}

/** Nearest-rank percentile; null on an empty list. */
const pctile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

(async () => {
  if (isPrivate) {
    // The private holdout, verified against eval/holdout/manifest.jsonl. No source: exit 2.
    try {
      const h = await loadPrivateHoldout();
      rows = h.items.map((it) => ({ id: it.item_id, prompt: '', candidate_answer: it.claim, label: it.label, split: 'holdout' }));
      hashed = h.set_sha256;
      RULER = holdoutRuler(h);
    } catch (e) {
      console.log(e instanceof Error ? e.message : String(e));
      if (e instanceof HoldoutNotCheckedError) console.log(`  missing: ${e.missing.join('; ')}`);
      process.exit(exitCodeFor(e));
    }
  }
  // Content-defined order, so `--limit k` and a --max-calls stop both name "the first k rows".
  const splitRows = rows.length;
  rows = evalOrder(rows);
  if (limit > 0) rows = rows.slice(0, limit);
  const measuredAt = new Date().toISOString();
  const runId = `local-${measuredAt}`;

  console.log(isolationBanner(ISOLATION));
  console.log(`ruler      : ${RULER}`);
  console.log(`scoring    : ${SCORING}`);
  console.log(`split      : ${split}${split === 'all' ? '  ** INCLUDES TRAIN — not a holdout number **' : ''}`);
  if (!isPrivate) console.log(`             ${retiredLine(`${stem} [${split}]`)}`);
  console.log(`rows       : ${rows.length}`);
  console.log(`transport  : IN-PROCESS halService (no HTTP, no public rate cap)`);
  console.log(`answer_mode: ${entry ? entry.answer_mode : 'claim-as-answer'}`);
  console.log(`max-calls  : ${maxCalls > 0 ? `${maxCalls} (concurrency forced to 1)` : 'none'}`);
  console.log('');

  // BUDGET COUNTER — installed before the HAL modules load, so nothing they fetch escapes it.
  // Our own database is not a provider quota; everything else is counted.
  let calls = 0;
  const hostOf = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return '';
    }
  };
  const dbHost = hostOf(process.env.SUPABASE_URL ?? '');
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!dbHost || hostOf(u) !== dbHost) calls++;
    return realFetch(input, init);
  }) as typeof fetch;

  // Required (not `await import`) AFTER dotenv, for two reasons:
  //   - this repo is "type": "commonjs"; ts-node resolves a dynamic import as
  //     ESM and fails with ERR_MODULE_NOT_FOUND on a real, present file.
  //   - the require must happen after dotenv so provider keys exist at module
  //     init — halService reads them when it is constructed, not per call.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { halService } = require('../../src/hal/service') as { halService: { evaluate: (i: unknown) => Promise<unknown> } };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildFactCheckProviders } = require('../../src/hal/fact-check') as {
    buildFactCheckProviders: () => Array<{ name: string; model?: string }>;
  };
  // CONFIGURED width (names and models, no keys). Who actually ANSWERED is printed after the run.
  const providersConfigured = buildFactCheckProviders().map((p) => `${p.name}:${p.model ?? '?'}`);
  console.log(`providers configured: [${providersConfigured.join(', ')}]`);

  const results: Scored[] = [];
  const queue = [...rows];
  let done = 0;
  let costliestRow = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        // Budget mode runs at concurrency 1, so calls - before is exactly this row's cost.
        if (maxCalls > 0 && calls + costliestRow > maxCalls) break;
        const row = queue.shift()!;
        const before = calls;
        const t0 = Date.now();
        try {
          const r: any = await halService.evaluate({
            text: row.candidate_answer,
            context: { domain: 'general', certainty: 0.8 },
            strictness: 2,
          });
          const sig = (r?.signals ?? {}) as Record<string, unknown>;
          results.push({
            id: row.id,
            truth: row.label,
            verdict: r?.verdict ?? r?.decision,
            halScore: r?.halScore ?? r?.hal_score,
            mode: r?.mode,
            familiesUsed: typeof sig.families_used === 'number' ? (sig.families_used as number) : undefined,
            families: Array.isArray(sig.families) ? (sig.families as string[]) : undefined,
            votes: Array.isArray(r?.provider_responses)
              ? (r.provider_responses as Array<{ verdict?: unknown }>).reduce<Record<string, number>>((a, v) => {
                  const k = String(v?.verdict ?? 'NONE');
                  a[k] = (a[k] ?? 0) + 1;
                  return a;
                }, {})
              : undefined,
            ms: Date.now() - t0,
            providers: Array.isArray(r?.provider_responses)
              ? (r.provider_responses as Array<Record<string, unknown>>).map((v) => ({
                  p: String(v.provider),
                  v: String(v.verdict ?? 'NONE'),
                  ...(typeof v.confidence === 'number' ? { c: v.confidence } : {}),
                  ...(typeof v.latency_ms === 'number' ? { ms: v.latency_ms } : {}),
                  ...(v.error ? { e: String(v.error).slice(0, 60) } : {}),
                }))
              : undefined,
          });
        } catch (e: any) {
          // A provider failure is NOT a wrong answer. Recorded separately and
          // excluded from the matrix — the mistake that once reported a dead
          // key as a math regression.
          results.push({ id: row.id, truth: row.label, error: String(e?.message ?? e).slice(0, 90), ms: Date.now() - t0 });
        }
        costliestRow = Math.max(costliestRow, calls - before);
        done++;
        if (done % 5 === 0 || done === rows.length) process.stdout.write(`\r  evaluated ${done}/${rows.length}`);
      }
    }),
  );
  console.log('\n');

  const errors = results.filter((r) => r.error);
  const scored = results.filter((r) => !r.error && r.verdict);
  const attempted = results.length;
  const sample = attempted < splitRows ? ` first ${attempted} of ${splitRows} (evalOrder)` : '';
  // SCORING v3: an abstain, a fallback, an error, a veto no checker voted FALSE for, or a row decided on
  // fewer than two families is NOT_CHECKED.
  const notCheckedN = results.filter(isNotCheckedV3).length;
  const noAgreementVetoes = results.filter((r) => !r.error && isNoAgreementVeto(r)).length;
  const underQuorum = results.filter((r) => !r.error && r.verdict && isUnderQuorum(r)).length;
  const notCheckedRate = attempted ? notCheckedN / attempted : 0;
  // ONE RULER PER ARTEFACT (XC1 on #1389). Every headline number below (confusion, precision,
  // recall, F1, accuracy, AUC, per class) is scoring v2: checked rows only. The old all-scored-rows
  // numbers are a different ruler and live under `legacy_all_scored`, named so they cannot be
  // read as the headline.
  const checkedRows = scored.filter((r) => !isNotCheckedV3(r));
  const checkedConfusion = confusionMatrix(checkedRows);
  const perClassScores = perClass(checkedConfusion);
  const budget = { max_calls: maxCalls || null, provider_calls: calls, costliest_row_calls: concurrency === 1 ? costliestRow : null, not_run: rows.length - attempted };

  // LATENCY: wall-clock per check over attempted rows (a failed check still made the caller wait).
  const rowMs = results.map((r) => r.ms).filter((x): x is number => typeof x === 'number');
  const latency = { p50_ms: pctile(rowMs, 0.5), p95_ms: pctile(rowMs, 0.95), n: rowMs.length, over: 'attempted rows; wall-clock of one in-process halService.evaluate' };
  // PROVIDER FAILURES by provider and kind (a failure is transport, never quality).
  const providerFailures: Record<string, Record<string, number>> = {};
  for (const r of results)
    for (const v of r.providers ?? [])
      if (v.v === 'ERROR') {
        const kind = /\b429\b/.test(v.e ?? '') ? '429' : /abort|timeout|timed out/i.test(v.e ?? '') ? 'timeout' : (v.e ?? 'unknown').slice(0, 24);
        (providerFailures[v.p] ??= {})[kind] = (providerFailures[v.p]![kind] ?? 0) + 1;
      }
  // COST from the ledger this run wrote. Local mode only: there it is this machine's own store.
  // cost_usd 0 on a paid model means UNPRICED (src/billing/pricing.ts), not free, so paid zero-cost calls are counted apart.
  let cost: { usd_total: number; usd_per_100_checks: number | null; calls_logged: number; tokens_in: number; tokens_out: number; zero_cost_calls_by_model: Record<string, number> } | null = null;
  if (ISOLATION.mode === 'local') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { db } = require('../../src/db') as { db: any };
    const { data } = await db.from('llm_call_log').select('*').gte('created_at', measuredAt);
    const logged = (data ?? []) as Array<{ cost_usd?: number; prompt_tokens?: number; completion_tokens?: number; provider?: string; model?: string; status?: string }>;
    const usd = logged.reduce((s, c) => s + (Number(c.cost_usd) || 0), 0);
    const zero: Record<string, number> = {};
    for (const c of logged) if (c.status === 'success' && !(Number(c.cost_usd) > 0)) zero[`${c.provider}:${c.model}`] = (zero[`${c.provider}:${c.model}`] ?? 0) + 1;
    cost = {
      usd_total: Math.round(usd * 1e6) / 1e6,
      usd_per_100_checks: attempted ? Math.round((usd / attempted) * 100 * 1e6) / 1e6 : null,
      calls_logged: logged.length,
      tokens_in: logged.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0),
      tokens_out: logged.reduce((s, c) => s + (c.completion_tokens ?? 0), 0),
      zero_cost_calls_by_model: zero,
    };
  }

  const { tp, fp, tn, fn } = checkedConfusion;
  const { precision, recall, f1, accuracy } = prf1(checkedConfusion);
  const legacyConfusion = confusionMatrix(scored);
  const legacy = {
    scoring: 'v0-all-scored-rows (abstain, fallback and no-agreement veto counted as answers)',
    confusion: legacyConfusion,
    ...prf1(legacyConfusion),
  };
  // Over rows attempted: a budget stop is not a transport failure (it is reported as not_run).
  const coverage = attempted ? scored.length / attempted : 0;

  // ROC AUC over the continuous halScore (rows with a numeric score only).
  const aucPoints = checkedRows
    .filter((r) => typeof r.halScore === 'number' && Number.isFinite(r.halScore))
    .map((r) => ({ score: r.halScore as number, positive: isHallucination(r.truth) }));
  const auc = rocAuc(aucPoints);

  // PROVIDER SET THAT ACTUALLY ANSWERED — the ruler is only valid with this named.
  // Count how many scored rows each family voted in, and the quorum-width histogram.
  const familyParticipation: Record<string, number> = {};
  const quorumWidthHist: Record<string, number> = {};
  let factCheckRows = 0;
  let fallbackRows = 0;
  // CHECKER FAMILIES PER ITEM (S60). An item answered by fewer than two distinct families is one
  // opinion, not a check: the run is 'incomplete' if any scored item was (F2 ledger rule).
  const perItemFamilies = new Map<string, string[]>();
  let incompleteItems = 0;
  for (const r of scored) {
    if (r.mode === 'fact-check') factCheckRows++;
    else fallbackRows++;
    if (typeof r.familiesUsed === 'number') quorumWidthHist[String(r.familiesUsed)] = (quorumWidthHist[String(r.familiesUsed)] ?? 0) + 1;
    for (const fam of r.families ?? []) familyParticipation[fam] = (familyParticipation[fam] ?? 0) + 1;
    perItemFamilies.set(r.id, r.families ?? []);
    if (familiesRecord(r.families ?? [], runId, measuredAt).status === 'incomplete') incompleteItems++;
  }
  const checkerPair = familiesRecord(Object.keys(familyParticipation), runId, measuredAt);
  if (incompleteItems > 0) checkerPair.status = 'incomplete';

  console.log(`=== confusion matrix (positive = hallucination), scoring ${SCORING}: checked rows only ===`);
  console.log(`  TP ${tp}   FP ${fp}`);
  console.log(`  FN ${fn}   TN ${tn}`);
  console.log('');
  console.log(`  precision ${precision.toFixed(4)}`);
  console.log(`  recall    ${recall.toFixed(4)}`);
  console.log(`  accuracy  ${accuracy.toFixed(4)}`);
  console.log(`  scored ${scored.length}/${attempted} attempted   errors ${errors.length}   not run (budget) ${budget.not_run}`);
  console.log(`  provider calls ${calls}${maxCalls > 0 ? ` of max ${maxCalls}; costliest row ${costliestRow}` : ''}`);
  console.log(`  latency p50 ${latency.p50_ms ?? 'n/a'} ms  p95 ${latency.p95_ms ?? 'n/a'} ms  (n=${latency.n}, ${latency.over})`);
  console.log(`  cost ${cost ? `$${cost.usd_total} total, $${cost.usd_per_100_checks} per 100 checks, ${cost.calls_logged} calls ledgered, zero-cost successes ${JSON.stringify(cost.zero_cost_calls_by_model)}` : 'not read (--write-prod: the ledger is production)'}`);
  console.log(`  provider failures ${JSON.stringify(providerFailures)}`);
  const verdicts = scored.reduce<Record<string, number>>(
    (a, r) => ((a[String(r.verdict)] = (a[String(r.verdict)] ?? 0) + 1), a),
    {},
  );
  console.log(`  verdicts ${JSON.stringify(verdicts)}`);
  console.log(`  AUC       ${auc == null ? 'undefined (single class)' : auc.toFixed(4)}   (ranks continuous halScore; F1 is at the veto threshold — different question)`);
  console.log('');
  console.log('=== provider set that ANSWERED (the ruler is only valid with this named) ===');
  console.log(`  fact-check rows ${factCheckRows}/${scored.length}   extractor-fallback rows ${fallbackRows}/${scored.length}`);
  console.log(`  quorum-width histogram (families that voted per row): ${JSON.stringify(quorumWidthHist)}`);
  console.log(`  family participation (scored rows each family voted in): ${JSON.stringify(familyParticipation)}`);
  console.log(`  checker families: ${checkerPair.status}${incompleteItems ? ` — ${incompleteItems} item(s) answered by fewer than two families` : ''}`);
  console.log('');

  // HAL_EVAL_OUT_DIR lets a test keep its output out of the checkout.
  const outDir = process.env.HAL_EVAL_OUT_DIR?.trim() || path.join(ROOT, 'reports', 'hal-eval');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('======================================================================');
  if (coverage < MIN_COVERAGE) {
    console.log(`  NO F1 REPORTED — coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${attempted}) below the ${(MIN_COVERAGE * 100).toFixed(0)}% floor.`);
    const kinds = errors.reduce<Record<string, number>>((a, e) => ((a[e.error!] = (a[e.error!] ?? 0) + 1), a), {});
    for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`     ${n}x  ${k}`);
    console.log('  This is NOT a HAL quality measurement and must not be quoted as one.');
    console.log('======================================================================');
    fs.writeFileSync(
      path.join(outDir, `${isPrivate ? stem : `${stem}-${split}`}-${hashed.slice(0, 12)}.LOCAL.INCOMPLETE.json`),
      JSON.stringify({ ruler: RULER, scoring: SCORING, never_compare: 'No F1: coverage (rows with any verdict, abstain and fallback included / attempted) is below the floor. This is a transport result, not a quality result.', isolation: ISOLATION, split, ...(isPrivate ? { holdout: 'private' } : retiredStamp()), coverage, scored: scored.length, rows: rows.length, attempted, errors: errors.length, error_kinds: kinds, budget, latency, cost, provider_failures: providerFailures, providers_configured: providersConfigured, results: isPrivate ? [] : results, f1: null }, null, 2),
    );
    process.exit(3);
  }

  const pc = perClassScores;
  const cls = (n: string, c: typeof pc.hallucination) =>
    `${n} P ${c.precision.toFixed(4)} R ${c.recall.toFixed(4)} F1 ${c.f1.toFixed(4)} (n=${c.support})`;
  console.log(`  F1 = ${f1.toFixed(4)} on ${RULER}${sample} [${split}] at ${Object.keys(familyParticipation).length} families, strictness 2, scoring ${SCORING} — checked rows only`);
  console.log(`  NOT_CHECKED ${notCheckedN}/${attempted} (${(notCheckedRate * 100).toFixed(1)}%): errors, abstains, extractor fallbacks, ${noAgreementVetoes} veto(es) no checker voted FALSE for and ${underQuorum} row(s) decided on fewer than two families — left out of the F1 above`);
  console.log(`  per class: ${cls('hallucination', pc.hallucination)} | ${cls('supported', pc.supported)}`);
  console.log(`  legacy_all_scored F1 = ${legacy.f1.toFixed(4)} (a different ruler: ${legacy.scoring}; never compare it with the line above)`);
  if (!isPrivate) console.log(`  ${retiredLine(`${stem} [${split}]`)}`);
  else console.log(`  PRIVATE HOLDOUT. checker families [${checkerPair.families.join(', ')}]: ${checkerPair.status}`);
  console.log(`  precision ${precision.toFixed(4)}  recall ${recall.toFixed(4)}  AUC ${auc == null ? 'n/a' : auc.toFixed(4)}`);
  console.log(`  coverage ${(coverage * 100).toFixed(1)}% (${scored.length}/${attempted})`);
  console.log(`  latency p50/p95 ${latency.p50_ms ?? 'n/a'}/${latency.p95_ms ?? 'n/a'} ms   cost $${cost?.usd_per_100_checks ?? 'n/a'} per 100 checks`);
  console.log(`  families that answered: [${Object.keys(familyParticipation).join(', ')}]`);
  console.log('======================================================================');

  const outName = `${isPrivate ? stem : `${stem}-${split}`}-${hashed.slice(0, 12)}.LOCAL.json`;
  fs.writeFileSync(
    path.join(outDir, outName),
    JSON.stringify(
      {
        ruler: `${RULER}${sample}`,
        corpus_sha256: hashed,
        scoring: SCORING,
        // Which ruler each number in this file is on (XC1 on #1389).
        never_compare:
          'The headline metrics (confusion, precision, recall, f1, accuracy, auc, per_class) are ' + SCORING + ' over checked rows only. ' +
          'legacy_all_scored is a different ruler. scored and coverage count every row with any verdict, abstain and extractor fallback included: ' +
          'they measure transport, not quality. Never compare numbers across these rulers.',
        counts: {
          attempted,
          scored_any_verdict: scored.length,
          checked_v2: checkedRows.length,
          not_checked_v2: notCheckedN,
        },
        isolation: ISOLATION,
        sample: { order: 'evalOrder: class-interleaved sha256(id)', attempted, of: splitRows },
        budget,
        latency,
        cost,
        provider_failures: providerFailures,
        providers_configured: providersConfigured,
        not_checked: { count: notCheckedN, rate: notCheckedRate, no_agreement_vetoes: noAgreementVetoes, under_quorum: underQuorum },
        split,
        ...(isPrivate ? { holdout: 'private' } : retiredStamp()),
        checker_pair: checkerPair,
        incomplete_items: incompleteItems,
        answer_mode: entry ? entry.answer_mode : 'claim-as-answer',
        transport: 'in-process halService',
        strictness: 2,
        concurrency,
        rows: rows.length,
        scored: scored.length,
        errors: errors.length,
        confusion: { tp, fp, tn, fn },
        precision,
        recall,
        f1,
        accuracy,
        auc,
        per_class: perClassScores,
        legacy_all_scored: legacy,
        verdicts,
        provider_set: {
          fact_check_rows: factCheckRows,
          extractor_fallback_rows: fallbackRows,
          quorum_width_histogram: quorumWidthHist,
          family_participation: familyParticipation,
        },
        // A private run writes counts only: an item id beside its truth is the label, in git.
        ...(isPrivate ? { results: [], results_withheld: 'private holdout: per-item ids and truth stay out of git' } : { results }),
      },
      null,
      2,
    ),
  );
  console.log(`\n  written: ${path.join(outDir, outName)}`);
  if (isPrivate) {
    const n = recordCheckerPairs(perItemFamilies, runId, measuredAt);
    console.log(`  checker families recorded for ${n} item(s) in eval/holdout/manifest.jsonl`);
  }
})();
