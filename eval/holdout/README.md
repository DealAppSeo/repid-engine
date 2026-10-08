# eval/holdout: the private rotating holdout

Sean, BUS S60, 2026-10-07: *"retire and replace. Stripping leaves the sentences in git history, so
the public set is still a training set. Retire those sets as the measurement holdout. Replace with
a private rotating set, edges and hashes only, checker pair recorded. Labeled examples may stay on
the site. They are not the score."*

## What is retired, and why

The holdout splits of `rigorous-v1` (99 rows) and `canary-v1` (15), and their copies, have been
public in git since July 2026. Deleting them from `HEAD` unpublishes nothing, and even without the
sentences a `source_id` field gives the label away on 190 of the 337 rigorous rows. So they are
no longer a holdout. They stay as training, regression and practice sets. The retirement is
recorded once in `data/hal_corpus_v1/MANIFEST.json` (`retired_as_holdout`, `retired_reason`,
`retired_copies`). Every script that scores those sets prints
`RETIRED PUBLIC SET: ... This is NOT a holdout score.` and writes `holdout: "retired-public"`.
The old split is still selectable as `--split retired-holdout`.

## What replaces it

A private set whose text never enters git. Git holds `manifest.jsonl`, one row per item:

| field | what it is |
|---|---|
| `item_id` | our own id |
| `claim_sha256` | sha256 of the normalized claim (`normalizeClaim` in `scripts/eval/holdout.ts`) |
| `label_commit` | sha256 of `holdout-label-v1`, the id, the label and the normalized claim |
| `edges` | records the label was decided on: `{ kind?, locator?, url, sha256 }`, the answer-key record shape minus `snapshot` and `outcome` |
| `checker_pair` | `{ families, checkers?, status, run_id, measured_at }` from the last run that scored the item, or `null` |
| `rotation` | the rotation the item entered in |
| `retire_after` | `YYYY-MM-DD`; after it the item stops counting |
| `retired_at` | `YYYY-MM-DD` or `null` |

**The label is not in git.** A public label next to an unsalted claim hash is an answer key for
anyone who can guess candidate sentences: hash every sentence of a source, look the hashes up
here, read off the answers. So git holds only `label_commit`. It pins the label (a later relabel of
the private copy fails verification) and cannot be read without the text. For the same reason an
edge has **no direction**: whether a record supports or contradicts the claim is the label in
another form, so it stays in the private file. The claim hash is unsalted on purpose, so that the
leak guard can find a copy. The price is that anyone who guesses a sentence exactly can confirm it
is in the set. Write fresh sentences; never copy public benchmark rows.

## Where the text lives

Read in this order by `loadPrivateHoldout`:

1. `HOLDOUT_FILE`: a local JSONL the operator keeps, one `{ item_id, claim, label, edges? }` per
   line (an edge here also carries `relation`). Keep it outside the repository, or name it
   `*.holdout.private.jsonl` or put it under `eval/holdout/private/` (both gitignored). An in-repo
   path that git does not ignore is refused.
2. The checker ledger: `ledger_items` rows where `holdout = true`, read with the service key
   (`supabase/migrations/20261006150000_checker_ledger.sql`; RLS on, no policies).
3. Neither: **NOT_CHECKED, exit 2**, naming which source was missing.

## What NOT_CHECKED means here

No private source was reachable, or the manifest has no active item, so nothing was measured.
It is exit 2, never 0. It is never a pass, and the runners never fall back to the retired public
sets. A mismatch is different: an active item missing from the private source, text that does not
hash to the manifest, a label that does not match its commitment, or a private item the manifest
does not list. That is **FAILED, exit 1**, and the message names item ids, never text.

    npx ts-node scripts/eval/holdout.ts verify

## Scoring it

`--split holdout` is the default of `run-frozen-corpus-local.ts` (the real quorum, in-process) and
`run-frozen-corpus-offline.ts` (the keyless extractor floor). `run-frozen-corpus.mjs` goes through
the public HTTP endpoint (10 requests a day); it says NOT_CHECKED for the holdout and points to the
local runner. A private run writes counts only to `reports/hal-eval/`. Per-item ids and truth stay
out of git. Scoring sends each private sentence to the checker hosts. A host that keeps prompts
has then seen it, which is one reason the set rotates.

## Checker pairs

A run records which checker families produced its verdicts. Two checkers of one model family (or
the same checker twice) are `incomplete`, as in the ledger's F2 rule (`pairBucket` in
`src/ledger/daily-totals.ts`): one opinion said twice is not a check. The in-process runner writes
each item's families into `checker_pair` and marks the run `incomplete` if any item was answered by
fewer than two families. The offline runner has no checker, so its runs are always `incomplete`.

## Rotation

    npx ts-node scripts/eval/holdout-rotate.ts retire
    npx ts-node scripts/eval/holdout-rotate.ts add --rotation <id> --retire-after YYYY-MM-DD [--from <private.jsonl>]

`retire` sets `retired_at` on every row past `retire_after`. Retired rows stay, so an old number
can still name its set. `add` registers every item in the private file (default `HOLDOUT_FILE`)
that the manifest does not list yet. It writes hashes, commitments and undirected edges, and prints
ids and counts only. Before writing anything it refuses a claim shorter than 12 or longer than 600
characters, an id or claim already registered, and any claim that already appears in a committed
file. Commit the manifest after either command.

## The leak guard

`tests/holdout-leak-guard.test.ts` hashes every candidate sentence in every committed file (and every
untracked file git does not ignore). Candidates are JSON and JSONL string values, lines, quoted
literals including SQL's `''`, table cells, and sentences. The test fails if any manifest hash
appears. It also fails if the scan is small, or if any of its five per-format positive controls
goes missing. It finds copies, not paraphrases, and not a sentence split across lines.
