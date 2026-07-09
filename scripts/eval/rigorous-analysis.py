#!/usr/bin/env python3
"""
RIGOROUS HAL EVAL — ANALYSIS (offline, deterministic, no LLM calls).
====================================================================
Reads the raw per-provider verdicts from scripts/eval/rigorous-hal-eval.ts and
computes the full statistical picture the skeptic asked for:

  * Headline quorum metrics: F1 / precision / RECALL / accuracy / AUC, each with a
    BOOTSTRAP 95% CI (percentile, B resamples over claims).
  * Monte-Carlo distribution: repeat the quorum decision over random provider
    subsets / drop-one perturbations -> spread, not a point estimate.
  * Ablations: best single model vs the family-aware quorum; k=1..K families.
  * THE THESIS EXPERIMENT: pairwise error-correlation (phi) + Cohen's kappa between
    providers, Fleiss' kappa overall, and the intra-family (same-weight groq vs
    deepinfra) vs inter-family contrast. Verdict on whether the "independent
    families" are actually independent.
  * Calibration: ECE + reliability bins on the derived hal_score.

Positive class = "catch a FALSE claim" (label FALSE). Pure stdlib.
Usage: python scripts/eval/rigorous-analysis.py --raw reports/2026-07-09/rigorous-raw.json
"""
import argparse, json, math, random, statistics as st
from collections import defaultdict, Counter

random.seed(1234)
B_BOOT = 10000

# ---------- verdict helpers ----------
def committed(v):  # a firm TRUE/FALSE vote (not ERROR/UNCERTAIN)
    return v.get("verdict") in ("TRUE", "FALSE") and not v.get("error")

def provider_risk(v):
    """HAL's per-provider risk in [0,1]: confident-FALSE->1, confident-TRUE->0."""
    c = (v.get("confidence") or 0) / 100.0
    if v["verdict"] == "FALSE": return 0.5 + 0.5 * c
    if v["verdict"] == "TRUE":  return 0.5 - 0.5 * c
    return 0.5

# ---------- confusion + metrics ----------
def metrics_from_pairs(pairs):
    """pairs: list of (pred_positive:bool|None, gold_positive:bool). None pred = abstain (excluded)."""
    tp=fp=tn=fn=ab=0
    for pred, gold in pairs:
        if pred is None: ab+=1; continue
        if gold and pred: tp+=1
        elif gold and not pred: fn+=1
        elif not gold and pred: fp+=1
        else: tn+=1
    prec = tp/(tp+fp) if (tp+fp) else 0.0
    rec  = tp/(tp+fn) if (tp+fn) else 0.0
    f1   = 2*prec*rec/(prec+rec) if (prec+rec) else 0.0
    dec  = tp+fp+tn+fn
    acc  = (tp+tn)/dec if dec else 0.0
    return dict(tp=tp,fp=fp,tn=tn,fn=fn,abstain=ab,precision=prec,recall=rec,f1=f1,accuracy=acc,decided=dec)

def auc_score(scored):
    """scored: list of (score, gold_positive). Rank-based AUC (Mann-Whitney), ties=0.5."""
    pos=[s for s,g in scored if g]; neg=[s for s,g in scored if not g]
    if not pos or not neg: return None
    wins=0.0
    for p in pos:
        for n in neg:
            wins += 1.0 if p>n else 0.5 if p==n else 0.0
    return wins/(len(pos)*len(neg))

# ---------- bootstrap ----------
def bootstrap_ci(items, stat_fn, B=B_BOOT):
    """items: list; stat_fn(sample)->float|None. Returns (point, lo, hi) percentile 95% CI."""
    point = stat_fn(items)
    n=len(items); vals=[]
    for _ in range(B):
        samp=[items[random.randrange(n)] for _ in range(n)]
        v=stat_fn(samp)
        if v is not None: vals.append(v)
    if not vals: return (point, None, None)
    vals.sort()
    lo=vals[int(0.025*len(vals))]; hi=vals[min(len(vals)-1,int(0.975*len(vals)))]
    return (point, lo, hi)

# ---------- decision rules ----------
def hal_pred_from_decision(decision, veto_only=False):
    """Map HAL's live decision to a binary positive(=FALSE caught) / None(abstain)."""
    if decision == "clean": return False
    if decision == "vetoed": return True
    if decision == "flagged": return None if veto_only else True
    return None  # abstain

def family_quorum_pred(verdicts, fam_of, families_allowed, min_false=2):
    """Recompute a family-aware quorum decision from raw verdicts, restricted to a family subset.
    A family 'votes FALSE' if any of its committed hosts voted FALSE. Caught if >= min_false families FALSE.
    Returns True/False/None(no committed vote in subset)."""
    false_fams=set(); any_committed=False
    for v in verdicts:
        f=fam_of.get(v["provider"])
        if f not in families_allowed: continue
        if not committed(v): continue
        any_committed=True
        if v["verdict"]=="FALSE": false_fams.add(f)
    if not any_committed: return None
    thr = min(min_false, len(families_allowed))
    return len(false_fams) >= thr

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", default="reports/2026-07-09/rigorous-analysis.json")
    a=ap.parse_args()
    run=json.load(open(a.raw,encoding="utf-8"))
    results=run["results"]
    fam_of={q["name"]:q["family"] for q in run["quorum"]}
    providers=[q["name"] for q in run["quorum"]]
    families=sorted(set(fam_of.values()))
    N=len(results)

    # ===== 1. HEADLINE (HAL live decision) =====
    def pairs_live(rows, veto_only=False):
        return [(hal_pred_from_decision(r["hal_decision"], veto_only), r["label"]=="FALSE") for r in rows]
    live_pairs=pairs_live(results)
    headline=metrics_from_pairs(live_pairs)
    # derived hal_score for AUC/calibration (mean provider_risk over committed verdicts)
    def row_score(r):
        cs=[provider_risk(v) for v in r["verdicts"] if committed(v)]
        return sum(cs)/len(cs) if cs else 0.5
    scored=[(row_score(r), r["label"]=="FALSE") for r in results]
    auc=auc_score(scored)

    # Bootstrap CIs (flag/veto=positive headline)
    ci={}
    ci["f1"]=bootstrap_ci(live_pairs, lambda s: metrics_from_pairs(s)["f1"])
    ci["precision"]=bootstrap_ci(live_pairs, lambda s: metrics_from_pairs(s)["precision"])
    ci["recall"]=bootstrap_ci(live_pairs, lambda s: metrics_from_pairs(s)["recall"])
    ci["accuracy"]=bootstrap_ci(live_pairs, lambda s: metrics_from_pairs(s)["accuracy"])
    ci["auc"]=bootstrap_ci(scored, auc_score)

    # veto-only variant (stricter: only 'vetoed' counts as a positive)
    veto_pairs=pairs_live(results, veto_only=True)
    headline_veto=metrics_from_pairs(veto_pairs)
    ci_veto_f1=bootstrap_ci(veto_pairs, lambda s: metrics_from_pairs(s)["f1"])
    ci_veto_recall=bootstrap_ci(veto_pairs, lambda s: metrics_from_pairs(s)["recall"])

    # per-source + per-difficulty breakdown
    def group_metrics(key):
        g=defaultdict(list)
        for r in results: g[r[key]].append((hal_pred_from_decision(r["hal_decision"]), r["label"]=="FALSE"))
        return {k:metrics_from_pairs(v) for k,v in sorted(g.items())}
    by_source=group_metrics("source")
    by_difficulty=group_metrics("difficulty")

    # ===== 2. ABLATIONS =====
    # (a) best single model — each provider's own committed verdict as the prediction.
    single={}
    for p in providers:
        pairs=[]
        for r in results:
            vv=[v for v in r["verdicts"] if v["provider"]==p]
            v=vv[0] if vv else None
            if v is None or not committed(v): pairs.append((None, r["label"]=="FALSE"))
            else: pairs.append((v["verdict"]=="FALSE", r["label"]=="FALSE"))
        single[p]=metrics_from_pairs(pairs)
    best_single=max(single.items(), key=lambda kv: kv[1]["f1"])

    # (b) family-aware quorum recomputed from raw verdicts (all families) — sanity vs live
    quorum_all_pairs=[(family_quorum_pred(r["verdicts"], fam_of, set(families)), r["label"]=="FALSE") for r in results]
    quorum_all=metrics_from_pairs(quorum_all_pairs)

    # (c) k = 1..K families: for each k, average F1 over several random family subsets
    k_ablation={}
    for k in range(1, len(families)+1):
        subs=[]
        # enumerate a bounded number of subsets for stability
        import itertools
        combos=list(itertools.combinations(families, k))
        random.shuffle(combos); combos=combos[:10]
        f1s=[]; recs=[]
        for combo in combos:
            pairs=[(family_quorum_pred(r["verdicts"], fam_of, set(combo)), r["label"]=="FALSE") for r in results]
            m=metrics_from_pairs(pairs); f1s.append(m["f1"]); recs.append(m["recall"])
        k_ablation[k]=dict(n_subsets=len(combos), mean_f1=st.mean(f1s), mean_recall=st.mean(recs),
                           min_f1=min(f1s), max_f1=max(f1s))

    # ===== 3. THESIS: inter-provider error correlation + kappa =====
    # Per provider: prediction vector (1=caught/FALSE-verdict, 0=TRUE-verdict) on claims it committed.
    pred={p:{} for p in providers}   # provider -> {row_idx: 1/0}
    for i,r in enumerate(results):
        for v in r["verdicts"]:
            if committed(v): pred[v["provider"]][i]=1 if v["verdict"]=="FALSE" else 0
    gold={i:(1 if r["label"]=="FALSE" else 0) for i,r in enumerate(results)}

    def err_vector(p):  # 1 = provider WRONG on that claim
        return {i:(1 if pred[p][i]!=gold[i] else 0) for i in pred[p]}

    def phi(a,b):  # correlation of two error vectors on shared claims
        common=set(a)&set(b)
        if len(common)<3: return None
        xa=[a[i] for i in common]; xb=[b[i] for i in common]
        n=len(common); ma=sum(xa)/n; mb=sum(xb)/n
        num=sum((xa[j]-ma)*(xb[j]-mb) for j in range(n))
        da=math.sqrt(sum((x-ma)**2 for x in xa)); db=math.sqrt(sum((x-mb)**2 for x in xb))
        if da==0 or db==0: return None
        return num/(da*db)

    def cohen_kappa(p1,p2):  # agreement on the raw prediction (caught vs not) beyond chance
        common=set(pred[p1])&set(pred[p2])
        if len(common)<3: return None
        a=[pred[p1][i] for i in common]; b=[pred[p2][i] for i in common]
        n=len(common); po=sum(1 for j in range(n) if a[j]==b[j])/n
        pa1=sum(a)/n; pb1=sum(b)/n
        pe=pa1*pb1+(1-pa1)*(1-pb1)
        return (po-pe)/(1-pe) if (1-pe)!=0 else None

    err={p:err_vector(p) for p in providers}
    pair_stats=[]
    for i in range(len(providers)):
        for j in range(i+1,len(providers)):
            p1,p2=providers[i],providers[j]
            same = fam_of[p1]==fam_of[p2]
            pair_stats.append(dict(pair=f"{p1}|{p2}", fam1=fam_of[p1], fam2=fam_of[p2], same_family=same,
                                   err_corr=phi(err[p1],err[p2]), kappa=cohen_kappa(p1,p2)))
    intra=[x for x in pair_stats if x["same_family"] and x["err_corr"] is not None]
    inter=[x for x in pair_stats if not x["same_family"] and x["err_corr"] is not None]
    def avg(xs,k):
        v=[x[k] for x in xs if x[k] is not None]; return st.mean(v) if v else None
    thesis=dict(
        intra_family_pairs=len(intra), inter_family_pairs=len(inter),
        mean_err_corr_intra=avg(intra,"err_corr"), mean_err_corr_inter=avg(inter,"err_corr"),
        mean_kappa_intra=avg(intra,"kappa"), mean_kappa_inter=avg(inter,"kappa"),
        pairs=sorted(pair_stats, key=lambda x:-(x["err_corr"] or -9)),
    )

    # Fleiss' kappa over providers on claims where ALL committed (fixed rater count).
    full_rows=[i for i in range(N) if all(i in pred[p] for p in providers)]
    fleiss=None
    if full_rows:
        R=len(providers); items=[]
        for i in full_rows:
            n1=sum(pred[p][i] for p in providers); items.append((n1, R-n1))
        n_items=len(items)
        p_j=[sum(it[c] for it in items)/(n_items*R) for c in (0,1)]
        Pe=sum(x*x for x in p_j)
        Pbar=sum((sum(c*c for c in it)-R)/(R*(R-1)) for it in items)/n_items
        fleiss=dict(kappa=(Pbar-Pe)/(1-Pe) if (1-Pe)!=0 else None, n_items=n_items, raters=R)

    # ===== 4. CALIBRATION (ECE on derived hal_score = P(FALSE)) =====
    bins=[[] for _ in range(10)]
    for s,g in scored:
        b=min(9,int(s*10)); bins[b].append((s,1 if g else 0))
    ece=0.0; reliab=[]
    for bi,cell in enumerate(bins):
        if not cell: reliab.append(dict(bin=bi/10, n=0, conf=None, acc=None)); continue
        conf=sum(s for s,_ in cell)/len(cell); acc=sum(g for _,g in cell)/len(cell)
        ece+=abs(conf-acc)*len(cell)/len(scored)
        reliab.append(dict(bin=bi/10, n=len(cell), conf=round(conf,3), acc=round(acc,3)))

    out=dict(
        raw=a.raw, n_claims=N, quorum=run["quorum"], providers=providers, families=families,
        providers_that_voted=run.get("providers_that_voted"),
        label_balance=dict(Counter(r["label"] for r in results)),
        provider_error_rate=run.get("provider_errors",0)/max(1,run.get("provider_calls",1)),
        headline_flagveto=headline, headline_auc=auc, ci=ci,
        headline_vetoonly=headline_veto, ci_vetoonly=dict(f1=ci_veto_f1, recall=ci_veto_recall),
        by_source=by_source, by_difficulty=by_difficulty,
        single_model=single, best_single=dict(provider=best_single[0], **best_single[1]),
        quorum_recomputed=quorum_all, k_family_ablation=k_ablation,
        thesis=thesis, fleiss=fleiss, calibration=dict(ece=ece, reliability=reliab),
    )
    json.dump(out, open(a.out,"w",encoding="utf-8"), indent=2)

    # ---- console summary ----
    def f(x): return "—" if x is None else f"{x:.3f}"
    print(f"\n=== RIGOROUS HAL ANALYSIS (N={N}, {out['label_balance']}) ===")
    print(f"providers voted: {out['providers_that_voted']}  provider_err_rate={out['provider_error_rate']:.3f}")
    print(f"\nHEADLINE (flag/veto=positive):")
    print(f"  F1       {f(headline['f1'])}  CI[{f(ci['f1'][1])},{f(ci['f1'][2])}]")
    print(f"  precision{f(headline['precision'])}  CI[{f(ci['precision'][1])},{f(ci['precision'][2])}]")
    print(f"  RECALL   {f(headline['recall'])}  CI[{f(ci['recall'][1])},{f(ci['recall'][2])}]")
    print(f"  accuracy {f(headline['accuracy'])}  AUC {f(auc)} CI[{f(ci['auc'][1])},{f(ci['auc'][2])}]")
    print(f"  confusion TP={headline['tp']} FP={headline['fp']} TN={headline['tn']} FN={headline['fn']} abstain={headline['abstain']}")
    print(f"\nVETO-ONLY (positive= 'vetoed' only): F1 {f(headline_veto['f1'])} recall {f(headline_veto['recall'])}")
    print(f"\nABLATION best single model: {best_single[0]} F1={f(best_single[1]['f1'])} recall={f(best_single[1]['recall'])}")
    print(f"           family quorum (recomputed): F1={f(quorum_all['f1'])} recall={f(quorum_all['recall'])}")
    print(f"  k-family: " + "  ".join(f"k={k}:F1={f(v['mean_f1'])}" for k,v in k_ablation.items()))
    print(f"\nTHESIS — error correlation / kappa:")
    print(f"  intra-family (same weights): mean err-corr {f(thesis['mean_err_corr_intra'])}  mean kappa {f(thesis['mean_kappa_intra'])}  (n={thesis['intra_family_pairs']})")
    print(f"  inter-family (distinct)    : mean err-corr {f(thesis['mean_err_corr_inter'])}  mean kappa {f(thesis['mean_kappa_inter'])}  (n={thesis['inter_family_pairs']})")
    if fleiss: print(f"  Fleiss kappa (all {fleiss['raters']} providers, {fleiss['n_items']} full-vote claims): {f(fleiss['kappa'])}")
    print(f"\nCALIBRATION ECE={ece:.3f}")
    print(f"\nwrote analysis -> {a.out}")

if __name__=="__main__":
    main()
