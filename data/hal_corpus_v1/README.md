# HAL Corpus (v1)

This directory contains the RACK (container format) for the hallucination-detection ground-truth corpus.
The corpus itself is EMPTY and stays empty until Sean defines truth and labelling policy.
It cannot be synthesised — a generated corpus measures the generator, not HAL.

To validate format and compute the deterministic content hash:
```bash
node scripts/corpus/hash-corpus.mjs data/hal_corpus_v1/example.jsonl
```

`example.jsonl` is a FORMAT example and is deliberately **rejected** by the validator
(its `source_url` is a placeholder). Running the command above on it should fail —
that is the provenance gate working. See `SCHEMA.md` → "Enforced gates".
