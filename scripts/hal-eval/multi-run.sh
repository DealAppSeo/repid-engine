#!/usr/bin/env bash
# multi-run.sh — run the frozen-corpus eval N times for a fixed config and collect the F1s, so a
# lever's effect can be read as mean±range ABOVE the run-to-run noise (free-tier models vary even at
# temperature 0). Usage: multi-run.sh <label> <N> [extra env, e.g. HAL_ESCALATE_GROK=true]
set -u
LABEL="${1:?label}"; N="${2:?count}"; shift 2
EXTRA="$*"
OUT="reports/hal-eval/_multirun-${LABEL}.txt"
: > "$OUT"
for i in $(seq 1 "$N"); do
  env $EXTRA npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --corpus rigorous-v1 --split holdout --concurrency 3 \
    > "reports/hal-eval/_multirun-${LABEL}-${i}.log" 2>&1
  F1=$(grep -oE "F1 = [0-9.]+" "reports/hal-eval/_multirun-${LABEL}-${i}.log" | tail -1 | grep -oE "[0-9.]+")
  P=$(grep -oE "precision [0-9.]+" "reports/hal-eval/_multirun-${LABEL}-${i}.log" | tail -1 | grep -oE "[0-9.]+")
  R=$(grep -oE "recall    [0-9.]+" "reports/hal-eval/_multirun-${LABEL}-${i}.log" | tail -1 | grep -oE "[0-9.]+")
  echo "run $i  F1=$F1  P=$P  R=$R" | tee -a "$OUT"
done
echo "--- $LABEL summary ($EXTRA) ---" | tee -a "$OUT"
awk '/^run/{n++; s+=$2+0; f[n]=$2+0; if($2+0>mx||n==1)mx=$2+0; if($2+0<mn||n==1)mn=$2+0}
     END{ if(n){printf "F1 mean=%.4f  min=%.4f  max=%.4f  n=%d\n", s/n, mn, mx, n} }' \
     <(grep -oE "F1=[0-9.]+" "$OUT" | sed 's/F1=/run x /') | tee -a "$OUT"
