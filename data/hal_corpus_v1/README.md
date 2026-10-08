# HAL Corpus (v1)

This directory contains the RACK (container format) for the hallucination-detection ground-truth corpus,
and two corpora in it: `rigorous-v1` and `canary-v1` (`MANIFEST.json`). This README used to say the corpus
was EMPTY; both have been here since 2026-08-06. A corpus cannot be synthesised: a generated corpus
measures the generator, not HAL.

**Their `holdout` splits are RETIRED as a holdout (S60, 2026-10-07).** The sentences have been public in
git since July, so these are training, regression and practice sets. `MANIFEST.json` records the
retirement (`retired_as_holdout`, `retired_reason`, `retired_copies`). Every score on them carries
`holdout: "retired-public"` and says it is not a holdout score. The old split is `--split retired-holdout`.
The measurement holdout is private: `eval/holdout/README.md`.

To validate format and compute the deterministic content hash:
```bash
node scripts/corpus/hash-corpus.mjs data/hal_corpus_v1/example.jsonl
```

`example.jsonl` is a FORMAT example and is deliberately **rejected** by the validator
(its `source_url` is a placeholder). Running the command above on it should fail —
that is the provenance gate working. See `SCHEMA.md` → "Enforced gates".
