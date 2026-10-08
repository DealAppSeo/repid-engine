# eval/rigorous

**Public, and retired as a holdout (S60, 2026-10-07).** These 337 claims, their 99-row holdout split
among them, have been in git since July. Every score on them is a regression number on a public set:
it carries `holdout: "retired-public"` and says it is not a holdout score. The measurement holdout is
private (`eval/holdout/README.md`).

`rigorous-corpus-v1.jsonl`: 337 labelled claims (canaries, FEVER, TruthfulQA, HaluEval), each with
its source URL. HaluEval's "FALSE" means a bad answer to a question, not always a false statement,
so report it separately.

`baseline-classify-2026-10-05.jsonl`: what each production voter said on every claim in one run
against production `POST /api/v1/classify` on 2026-10-05, after repid-engine #1206
(Groq `openai/gpt-oss-120b` + Cerebras `qwen-3.8-27b`, qwen reasoning off). Per-voter readings come
from `/api/v1/classify/stats` deltas around each call; 9 rows where other traffic landed in the same
window are `null`, never guessed.

## Evaluating a candidate second voter

    npm run eval:candidate-voter -- --voter nvidia-nim:<model id>

It answers the 337 claims with the candidate once, through the production voting code, and pairs
those answers with the stored Groq readings: the label production would have given, with no Groq
call. It needs the candidate's key in the session environment (`NVIDIA_NIM_API_KEY` for
`nvidia-nim`) and the host allowed by the session's network policy. It refuses an id the host does
not list. NVIDIA's free API keys are for development and test use only, so a model that wins is
served in production from a host whose terms allow it, never from that key.

## Re-runs

`rerun-assumptions-on-2026-10-06.jsonl`: 75 of the 337 claims (stratified by source and by the
2026-10-05 label, seed 20261006), sent once each to production on 2026-10-06 06:50-07:03Z with
`CLASSIFY_ASSUMPTIONS=on` and `CLASSIFY_QUESTIONS=on`. Same row ids, truth and per-voter
`/classify/stats` deltas as the baseline; no claim text.

    npm run eval:backtest-classify -- --compare eval/rigorous/rerun-assumptions-on-2026-10-06.jsonl

Same 75 rows: decided 41 -> 30, wrong stamps 1 -> 1. Twelve correct stamps became not-checked and
one not-checked became a correct pass; in 11 of the 12 the qwen voter moved from the right verdict
to UNSURE. The assumption sentence cost coverage on ordinary claims and removed no wrong stamp here.
