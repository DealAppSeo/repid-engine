# HAL corpus v1-frozen: inventory and the Friday 2026-10-16 run plan

Board item P0-5, "Freeze HAL corpus v1". CLAUDE_RULES 24: a measurement without its ruler is not a result.
No provider was called and no HAL evaluation was run while preparing this.

## 1. What exists (checked 2026-10-14)

| set | rows | provenance | status |
|---|---|---|---|
| `rigorous-v1` @596f10de18d0 | 331 (170 TRUE / 161 FALSE) | 284 rows from published benchmarks with dataset + item id + URL; 47 canary rows we wrote ourselves | frozen 2026-08-06; holdout retired 2026-10-07 |
| `canary-v1` @dbaf5dbd4e55 | 50 | claims written in this repo (commit 9ccc91a1), each citing Wikipedia; no third-party item id | frozen; holdout retired |
| **`hal-v1-frozen` @1a3ef7ac5c37** | **284 (142 TRUE / 142 FALSE)** | **284/284 (100%)**: HaluEval 100, FEVER 100, TruthfulQA 84 | **new, this change** |
| private holdout (`eval/holdout/manifest.jsonl`) | **0 items** | none yet | empty |
| Supabase `hal_test_cases` | 2517 (2342 distinct texts) | about 1480 swarm-written rows with no source URL; 64 hand-written; 973 benchmark imports, of which 673 carry item ids and 300 (a HaluEval import) do not | mutable, unhashed; not used |

`hal-v1-frozen` is every rigorous-v1 row whose notes name a published benchmark, byte-identical to its
rigorous-v1 line. Nothing was relabelled or added. Its full sha256 and the exclusions with reasons are in
`data/hal_corpus_v1/MANIFEST.json`. Provenance (source, source_id, url) was assigned mechanically by
`scripts/eval/build-rigorous-corpus.py` from the upstream files. **Not re-checked here:** the upstream
files were not re-fetched to re-match each row. That check is still open.

Guards: `tests/corpus-files.test.ts` re-derives the hash and the class and split counts from the file
and fails on any drift. A new test also fails if a row is not an unchanged third-party row of
rigorous-v1, which catches an edit that was re-hashed into the manifest. Both were broken on purpose and
went red (3 failures for a flipped label; 1 for a flipped label with the manifest re-hashed), then were
restored.

## 2. Is there a clean holdout? No.

- Every row of all three public sets has been in git since July. S60 retired them as a holdout on 2026-10-07.
- The rigorous-v1 holdout split was **used to tune**: `reports/hal-eval/hal-calibrator-rigorous-v1.json`
  was fitted on it (`fittedOn: 99`), and it was scored under at least four configurations.
- One FEVER row and 8 canary rows also appear word for word in prod `hal_test_cases`, the table the
  validation runs used. Overlap for the 184 question-and-answer rows was NOT_CHECKED, because prod stores
  them in a different shape and a text match cannot find them.

So `hal-v1-frozen` keeps rigorous-v1's `split` field for regression only. **Every score on it is
`holdout: retired-public`.** The runner says so in its output. The one set that can produce a holdout
score is the private holdout, and it has 0 items. Run against it on Friday, `--split holdout` exits 2
NOT_CHECKED.

**Decision for Sean:** populate the private holdout before Friday (write new sentences, labels and
evidence edges privately, register them with `scripts/eval/holdout-rotate.ts add`, then commit the
hashes-only manifest), or accept that Friday's number is a regression number on a public set.

## 3. Friday run (operator: PowerShell, from the repo root on merged main)

Step 0 is free and can run at any time. It is the keyless extractor floor and makes 0 provider calls:

    npx ts-node scripts/hal-eval/run-frozen-corpus-offline.ts --corpus hal-v1-frozen --split all

Step 1 is a smoke pass of at most 10 calls. It shows that keys load, prints `providers configured`, and
exercises the budget counter end to end. The counter was type-checked but has not been executed yet.

    npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --corpus hal-v1-frozen --split all --limit 2 --max-calls 10

Stop if fewer than 2 families answer or both rows error. A 1-family run cannot clear or veto anything.

Step 2 is the measurement:

    npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --corpus hal-v1-frozen --split all --max-calls 400

- **n:** up to 284 rows, taken in `evalOrder` (each class sorted by sha256(id), alternated). Every
  prefix is within one row of 50/50, so a run cut short by the budget still scores both classes.
- **Providers:** whatever `buildFactCheckProviders()` resolves from the env. groq and cerebras are on
  by default; gemini, mistral, deepseek and the others only with `HAL_S2_ENABLE_*=true`. The run prints
  the configured list and the families that actually answered.
- **Calls:** the free providers run in parallel first. If fewer than 3 families answer, the cheap wave
  runs, then the escalation wave. On top of that come at most 1 retry per 429, a Grok tiebreak when the
  families are evenly split, and 1 prefilter call when JEV is enabled. ~~Expect about 3 to 5 calls a
  row, so 400 calls cover roughly 80 to 130 rows.~~ **Corrected 2026-10-15 [measured]:** the operator's
  key file configures 7 providers. In the smoke the free wave was rate-limited, and the first row
  cost **9** calls. So 400 calls cover about **44** rows, and the paid slots (deepseek, anthropic) are
  called whenever the free wave fails (`E:/dev/reports/2026-10-15/CC1_HAL_SMOKE_2026-10-15.md`). `--max-calls`
  counts every outbound call that is not to Supabase. The overshoot is at most one row. The first row
  always runs.
- **Isolation (2026-10-15):** a run writes nothing to production by default (`measure-isolation.ts`):
  `llm_call_log` and `ops_alerts` go to a local SQLite file, Dragonfly and Telegram are off. Pass
  `--write-prod` only for a run that is meant to be production traffic.
- **Window:** Fri 2026-10-16 **00:15 UTC**, just after providers that reset at UTC midnight have reset.
  The smoke at 01:26 UTC still met 429s from OpenRouter's shared upstream pool and from Mistral, so
  timing does not remove rate limits.
  [reported, not verified] Gemini's free daily quota resets at midnight Pacific, which is 07:00 UTC in
  October. If gemini is in the configured set, run at **07:15 UTC** instead. Check the remaining Groq
  quota in its console first: live HAL and the T12 swarm use the same key.
- **Precision you can expect:** at about 100 rows, 50 per class, a per-class recall carries a 95%
  interval of roughly ±0.1. Do not read differences smaller than that as a change.

## 4. How the result is reported (all of it, or it is not quoted)

    F1 = <x> on hal-v1-frozen@1a3ef7ac5c37 first <k> of 284 (evalOrder) [all] at <N> families, strictness 2, scoring v2-no-agreement-is-not-checked, checked rows only
    NOT_CHECKED <a>/<k> (<r>%): errors, abstains, extractor fallbacks and vetoes no checker voted FALSE for, left out of the F1 above
    per class: hallucination P/R/F1 (n) | supported P/R/F1 (n)
    legacy F1 (abstain scored as a pass) = <y>; providers configured [...]; families answered [...];
    quorum-width histogram {...}; provider calls <c> of max 400; runner commit <sha>
    RETIRED PUBLIC SET: not a holdout score.

The runner prints these lines and writes them to `reports/hal-eval/hal-v1-frozen-all-1a3ef7ac5c37.LOCAL.json`.
A coverage below 80% prints no F1 and exits 3: that is a transport failure, not a quality result. **Never
compare** this number with 0.34 / 0.74 / 0.886 / 0.890, with rigorous-v1 numbers or with
`hal_validation_runs`. Those are different rulers.

## 5. Changes in this PR

- `data/hal_corpus_v1/hal-v1-frozen.jsonl` + MANIFEST entry (and listed in `retired_copies`).
- `run-frozen-corpus-local.ts`: `--max-calls`, `evalOrder` for `--limit`/budget prefixes, the
  configured provider list, the NOT_CHECKED rate, an F1 over checked rows and per-class scores. The
  legacy `f1` field keeps its old meaning so earlier runs stay comparable. Coverage is now taken over
  attempted rows.
- `metrics.ts`: `isNotChecked`, `perClass`, `evalOrder`, with tests in `tests/hal-quorum-eval-smoke.test.ts`.
