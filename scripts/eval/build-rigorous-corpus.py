#!/usr/bin/env python3
"""
BUILD RIGOROUS HAL CORPUS  (provenance-required; RULE-19)
=========================================================
Assembles a balanced, fully-provenanced TRUE/FALSE claim corpus from established
PUBLIC hallucination / truthfulness benchmarks + the on-disk canary corpus, so
the skeptic's "why N=47?" is answered with a real several-hundred-item set.

EVERY scored row carries {source, source_id, url, label}. No synthetic rows enter
the headline set. (SimpleQA is intentionally EXCLUDED from the scored set: it ships
only correct answers with no gold distractors, so a balanced FALSE side cannot be
built from it without fabrication — it is listed in the manifest as available-but-
unscored to stay honest.)

INPUTS (re-downloadable; not committed — too large):
  HaluEval QA : https://raw.githubusercontent.com/RUCAIBox/HaluEval/main/data/qa_data.json
  FEVER  dev  : https://fever.ai/download/fever/shared_task_dev.jsonl
  TruthfulQA  : https://raw.githubusercontent.com/sylinrl/TruthfulQA/main/TruthfulQA.csv
  canary v1.1 : eval/canary/canary-corpus-v1.1.jsonl   (already in-repo, provenanced)

USAGE:
  python scripts/eval/build-rigorous-corpus.py --data-dir <dir-with-raw-files> \
         --out eval/rigorous/rigorous-corpus-v1.jsonl
Deterministic: fixed seed → same sample every run (reproducible provenance).
"""
import argparse, csv, hashlib, json, os, random, sys
from collections import Counter

SEED = 42

def sha8(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]

def qa_statement(question: str, answer: str) -> str:
    q = " ".join(str(question).split())
    a = " ".join(str(answer).split())
    return f"Q: {q} A: {a}"

def load_fever(path, n_true, n_false, rng):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            lab = str(r.get("label", "")).upper().strip()
            claim = r.get("claim")
            if claim is None:
                continue
            if lab == "SUPPORTS":
                rows.append(("TRUE", r))
            elif lab == "REFUTES":
                rows.append(("FALSE", r))
            # NOT ENOUGH INFO dropped (no gold truth value)
    trues = [r for (l, r) in rows if l == "TRUE"]
    falses = [r for (l, r) in rows if l == "FALSE"]
    rng.shuffle(trues); rng.shuffle(falses)
    out = []
    for r in trues[:n_true]:
        out.append(dict(source="fever", source_id=f"fever-{r['id']}", url="https://fever.ai/dataset/fever.html",
                        claim=str(r["claim"]).strip(), label="TRUE", domain="fact-verification",
                        difficulty="mixed", construction="claim-verbatim"))
    for r in falses[:n_false]:
        out.append(dict(source="fever", source_id=f"fever-{r['id']}", url="https://fever.ai/dataset/fever.html",
                        claim=str(r["claim"]).strip(), label="FALSE", domain="fact-verification",
                        difficulty="mixed", construction="claim-verbatim"))
    return out

def load_halueval(path, n_true, n_false, rng):
    recs = []
    with open(path, encoding="utf-8") as f:
        for idx, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("right_answer") is not None and r.get("hallucinated_answer") is not None:
                recs.append((idx, r))
    rng.shuffle(recs)
    trues, falses = [], []
    for idx, r in recs:
        q = r["question"]
        trues.append((idx, q, r["right_answer"]))
        falses.append((idx, q, r["hallucinated_answer"]))
    out = []
    url = "https://github.com/RUCAIBox/HaluEval/blob/main/data/qa_data.json"
    for idx, q, a in trues[:n_true]:
        out.append(dict(source="halueval", source_id=f"halueval-qa-{idx}-right", url=url,
                        claim=qa_statement(q, a), label="TRUE", domain="qa-knowledge",
                        difficulty="mixed", construction="qa->statement"))
    for idx, q, a in falses[:n_false]:
        out.append(dict(source="halueval", source_id=f"halueval-qa-{idx}-hallu", url=url,
                        claim=qa_statement(q, a), label="FALSE", domain="qa-knowledge",
                        difficulty="mixed", construction="qa->statement"))
    return out

def load_truthfulqa(path, n_true, n_false, rng):
    rows = list(csv.DictReader(open(path, encoding="utf-8")))
    idxs = list(range(len(rows)))
    rng.shuffle(idxs)
    out = []
    t = 0; fcount = 0
    for i in idxs:
        r = rows[i]
        q = r.get("Question", "").strip()
        best = r.get("Best Answer", "").strip()
        worst = r.get("Best Incorrect Answer", "").strip()
        src = (r.get("Source", "") or "").strip() or "https://github.com/sylinrl/TruthfulQA"
        cat = (r.get("Category", "") or "misc").strip()
        if best and t < n_true:
            out.append(dict(source="truthfulqa", source_id=f"truthfulqa-{i}-true", url=src,
                            claim=qa_statement(q, best), label="TRUE", domain=f"truthfulqa/{cat}",
                            difficulty="adversarial", construction="qa->statement")); t += 1
        if worst and fcount < n_false:
            out.append(dict(source="truthfulqa", source_id=f"truthfulqa-{i}-false", url=src,
                            claim=qa_statement(q, worst), label="FALSE", domain=f"truthfulqa/{cat}",
                            difficulty="adversarial", construction="qa->statement")); fcount += 1
        if t >= n_true and fcount >= n_false:
            break
    return out

def load_canary(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for idx, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out.append(dict(source="canary", source_id=f"canary-v1.1-{idx}",
                            url=r.get("source_url", "") or "in-repo:eval/canary/canary-corpus-v1.1.jsonl",
                            claim=r["claim"], label=r["label"], domain=r.get("domain", "canary"),
                            difficulty=r.get("difficulty", "mixed"), construction="claim-verbatim"))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, help="dir with halueval_qa.json / fever_dev.jsonl / truthfulqa.csv")
    ap.add_argument("--canary", default="eval/canary/canary-corpus-v1.1.jsonl")
    ap.add_argument("--out", default="eval/rigorous/rigorous-corpus-v1.jsonl")
    ap.add_argument("--fever", type=int, default=50, help="TRUE and FALSE each from FEVER")
    ap.add_argument("--halueval", type=int, default=50)
    ap.add_argument("--truthfulqa", type=int, default=45)
    args = ap.parse_args()
    rng = random.Random(SEED)

    rows = []
    rows += load_fever(os.path.join(args.data_dir, "fever_dev.jsonl"), args.fever, args.fever, rng)
    rows += load_halueval(os.path.join(args.data_dir, "halueval_qa.json"), args.halueval, args.halueval, rng)
    rows += load_truthfulqa(os.path.join(args.data_dir, "truthfulqa.csv"), args.truthfulqa, args.truthfulqa, rng)
    rows += load_canary(args.canary)

    # de-dup by claim text; assign global row_id; verify provenance completeness
    seen = set(); final = []
    for r in rows:
        key = r["claim"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        assert r["source"] and r["source_id"] and r["url"] and r["label"] in ("TRUE", "FALSE"), f"provenance gap: {r}"
        r["row_id"] = f"{r['source']}-{sha8(r['claim'])}"
        final.append(r)
    rng.shuffle(final)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in final:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    by_src = Counter(r["source"] for r in final)
    by_lab = Counter(r["label"] for r in final)
    print(f"wrote {len(final)} provenanced rows -> {args.out}")
    print("by source:", dict(by_src))
    print("by label :", dict(by_lab))

if __name__ == "__main__":
    main()
