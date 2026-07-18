#!/usr/bin/env python3
"""
BUILD DECONTAMINATED HAL CORPUS  (provenance-required; RULE-19)
==============================================================
Antifragile Provenance Program WS1.5 (reports/2026-07-18/ANTIFRAGILE_PROVENANCE_PROGRAM_v0.md).

The prior scored corpus (eval/rigorous/rigorous-corpus-v1.jsonl) draws from
FEVER + HaluEval + TruthfulQA — benchmarks that are contaminated / saturated in
modern LLM pre-training and whose gold labels have known errors (the #11 Lana Del
Rey mislabel). That caps the *measured* F1. This script builds a CLEAN corpus from
two decontaminated, professionally-labeled sources so HAL's honest number can be
read without the label-quality ceiling.

SOURCES
  1. google/simpleqa-verified  (decontaminated short-form factuality, passage-free)
     - Q + gold answer. TRUE claim = "Q: <problem> A: <gold>".
     - FALSE claim = "Q: <problem> A: <distractor>", where the distractor is a REAL
       answer mined from a DIFFERENT SimpleQA question of the SAME answer_type
       (Number/Date/Person/Place/Other), guaranteed != gold (case-insensitive) and
       preferring a different topic. SimpleQA questions are highly specific, so a
       borrowed same-type answer is type-consistent, plausible-in-form, and almost
       certainly wrong for THIS question -> a clean FALSE with no fabrication (the
       distractor value is itself provenanced from the dataset).
     - This is HAL's native task shape: parametric world-truth, no context needed.

  2. PatronusAI/HaluBench  (professionally-labeled PASS/FAIL hallucination labels)
     - HaluBench is a GROUNDED (RAG-faithfulness) benchmark: the label is defined
       relative to a passage. So the claim MUST embed the passage for the PASS/FAIL
       label to be reproducible by HAL. HAL's fact-check prompt truncates the
       statement at 1200 chars (src/hal/fact-check.ts factCheckPrompt), so we keep
       only rows whose embedded claim fits UNDER that cap (passage+q+a budget 1000).
     - The `halueval` subset of HaluBench is EXCLUDED: it is the same source as the
       contaminated corpus we are moving away from (decontamination). `covidQA` (all
       passages >13k chars, 0 fit) and `DROP` (list-shaped answers) are excluded too.
     - Kept subsets: FinanceBench + pubmedQA (balanced PASS/FAIL).
     - construction = "passage-grounded"; this is a DIFFERENT task shape than
       SimpleQA (grounded faithfulness vs parametric world-truth) — the analysis
       breaks results down by `source` so the two are separable.

EVERY row carries {source, source_id, url, label in {TRUE,FALSE}}. No synthetic,
unprovenanced rows. Deterministic (fixed seed) -> reproducible sample.

USAGE:
  python scripts/eval/build-decontaminated-corpus.py \
     --halubench <dir>/halubench.parquet \
     --simpleqa  <dir>/simpleqa_verified.parquet \
     --out eval/rigorous/decontaminated-corpus-v1.jsonl
"""
import argparse, hashlib, json, random
from collections import Counter, defaultdict
import pyarrow.parquet as pq

SEED = 42
FACT_CHECK_CAP = 1200          # src/hal/fact-check.ts truncates the statement here
GROUNDED_CLAIM_MAX = 1150      # keep embedded-passage claims safely under the cap

SIMPLEQA_URL = "https://huggingface.co/datasets/google/simpleqa-verified"
HALUBENCH_URL = "https://huggingface.co/datasets/PatronusAI/HaluBench"


def sha8(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]


def qa_statement(question: str, answer: str) -> str:
    q = " ".join(str(question).split())
    a = " ".join(str(answer).split())
    return f"Q: {q} A: {a}"


def first_url(urls_field, fallback):
    if not urls_field:
        return fallback
    u = str(urls_field).split(",")[0].strip().rstrip(")")
    return u or fallback


# ---------------------------------------------------------------- SimpleQA Verified
def build_simpleqa(path, n_questions, rng):
    rows = pq.read_table(path).to_pylist()
    # distractor pools keyed by answer_type: list of (answer, topic, orig_index)
    pools = defaultdict(list)
    for r in rows:
        a = str(r["answer"]).strip()
        if a:
            pools[r["answer_type"]].append((a, r["topic"], r["original_index"]))
    for t in pools:
        rng.shuffle(pools[t])

    # candidate questions: non-empty problem+answer, has a url
    cands = [r for r in rows if str(r["problem"]).strip() and str(r["answer"]).strip()]
    rng.shuffle(cands)
    selected = cands[:n_questions]

    out = []
    for r in selected:
        gold = str(r["answer"]).strip()
        q = str(r["problem"]).strip()
        oi = r["original_index"]
        topic = r["topic"]
        atype = r["answer_type"]
        url = first_url(r.get("urls"), SIMPLEQA_URL)
        diff = "hard" if (r.get("multi_step") or r.get("requires_reasoning")) else "medium"

        # TRUE
        out.append(dict(source="simpleqa_verified",
                        source_id=f"simpleqa-verified-{oi}-true", url=url,
                        claim=qa_statement(q, gold), label="TRUE",
                        domain=f"simpleqa/{topic}", difficulty=diff,
                        construction="qa->statement"))

        # FALSE: type-matched distractor from a DIFFERENT question, != gold.
        # Prefer SAME topic + same answer_type first -> the wrong answer is
        # plausible-in-domain (a wrong politician for a politics question), which
        # makes the FALSE side genuinely hard rather than obvious nonsense (an
        # honest, non-inflated recall measurement). SimpleQA questions are unique,
        # so same-topic collision with the gold is still negligible. Fall back to
        # any same-type answer if the topic pool is thin.
        distractor = None
        for require_same_topic in (True, False):
            for (a, tp, di) in pools[atype]:
                if di == oi:
                    continue
                if a.strip().lower() == gold.lower():
                    continue
                if require_same_topic and tp != topic:
                    continue
                distractor = a
                break
            if distractor:
                break
        if not distractor:
            continue  # no usable distractor -> skip the FALSE side (keeps honesty)
        out.append(dict(source="simpleqa_verified",
                        source_id=f"simpleqa-verified-{oi}-false", url=url,
                        claim=qa_statement(q, distractor), label="FALSE",
                        domain=f"simpleqa/{topic}", difficulty=diff,
                        construction="qa->distractor-substitution"))
    return out


# ---------------------------------------------------------------- HaluBench (grounded)
def grounded_claim(passage, question, answer):
    p = " ".join(str(passage).split())
    q = " ".join(str(question).split())
    a = " ".join(str(answer).split())
    return (f'Passage: "{p}"\n\n'
            f'Claim: Based only on the passage above, the correct answer to the '
            f'question "{q}" is: {a}')


def build_halubench(path, per_subset, rng):
    rows = pq.read_table(path).to_pylist()
    keep_subsets = ("FinanceBench", "pubmedQA")  # decontaminated, fit-able, non-overlapping
    out = []
    for sub in keep_subsets:
        sub_rows = [r for r in rows if r["source_ds"] == sub]
        # fit filter: embedded claim must stay under the fact-check truncation cap
        fitted = []
        for r in sub_rows:
            claim = grounded_claim(r["passage"], r["question"], r["answer"])
            if len(claim) <= GROUNDED_CLAIM_MAX:
                fitted.append((r, claim))
        pass_rows = [(r, c) for (r, c) in fitted if r["label"] == "PASS"]
        fail_rows = [(r, c) for (r, c) in fitted if r["label"] == "FAIL"]
        rng.shuffle(pass_rows); rng.shuffle(fail_rows)
        k = min(per_subset, len(pass_rows), len(fail_rows))  # balanced per subset
        chosen = pass_rows[:k] + fail_rows[:k]
        for (r, claim) in chosen:
            label = "TRUE" if r["label"] == "PASS" else "FALSE"
            out.append(dict(source="halubench",
                            source_id=f"halubench-{sub}-{r['id']}", url=HALUBENCH_URL,
                            claim=claim, label=label,
                            domain=f"halubench/{sub}", difficulty="grounded-faithfulness",
                            construction="passage-grounded"))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--halubench", required=True)
    ap.add_argument("--simpleqa", required=True)
    ap.add_argument("--out", default="eval/rigorous/decontaminated-corpus-v1.jsonl")
    ap.add_argument("--simpleqa-questions", type=int, default=70)
    ap.add_argument("--halubench-per-subset", type=int, default=43)
    args = ap.parse_args()
    rng = random.Random(SEED)

    rows = []
    rows += build_simpleqa(args.simpleqa, args.simpleqa_questions, rng)
    rows += build_halubench(args.halubench, args.halubench_per_subset, rng)

    # de-dup by claim text; assign row_id; verify provenance completeness
    seen = set(); final = []
    for r in rows:
        key = r["claim"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        assert r["source"] and r["source_id"] and r["url"] and r["label"] in ("TRUE", "FALSE"), f"provenance gap: {r}"
        assert len(r["claim"]) <= FACT_CHECK_CAP, f"claim exceeds fact-check cap: {r['source_id']}"
        r["row_id"] = f"{r['source']}-{sha8(r['claim'])}"
        final.append(r)
    rng.shuffle(final)

    import os
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in final:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    by_src = Counter(r["source"] for r in final)
    by_lab = Counter(r["label"] for r in final)
    by_srclab = defaultdict(Counter)
    for r in final:
        by_srclab[r["source"]][r["label"]] += 1
    first160 = Counter(r["label"] for r in final[:160])
    print(f"wrote {len(final)} provenanced rows -> {args.out}")
    print("by source:", dict(by_src))
    print("by label :", dict(by_lab))
    print("by source+label:", {k: dict(v) for k, v in by_srclab.items()})
    print("first-160 label balance (RIG_LIMIT window):", dict(first160))


if __name__ == "__main__":
    main()
