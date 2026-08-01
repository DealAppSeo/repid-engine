# HAL Corpus (v1)

This directory contains the RACK (container format) for the hallucination-detection ground-truth corpus.
The actual corpus is empty and will remain empty until Sean defines truth and labeling policies.

To validate format and compute the deterministic content hash:
```bash
node scripts/corpus/hash-corpus.mjs data/hal_corpus_v1/example.jsonl
```
