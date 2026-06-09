/**
 * CHECK — HAL ablation invariant: the HAL ensemble (B) is at least as discriminative as a plain
 * 3-LLM majority vote (A) on the persisted labeled corpus, and is itself discriminative (AUC well
 * above chance). Reads scripts/hal-ablation/data/ablation-results.json (produced by
 * scripts/hal-ablation/run-ablation.ts). If that artifact is absent → SKIP (never a silent pass).
 *
 * Rationale: the Pythagorean Comma is a constant scalar, so it cannot raise AUC over the plain
 * ensemble — B >= A (within tolerance) is the honest bar. A regression where the ensemble path
 * scores BELOW plain majority, or collapses toward chance, is a real finding worth blocking on.
 */
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { CheckResult, pass, fail, skip } from '../lib/types';

const ID = 'hal-ablation';
const TITLE = 'HAL ablation (B AUC ≥ plain-majority A, B discriminative)';
const TOL = 0.02;        // AUC noise tolerance
const MIN_DISCRIM = 0.60; // B must beat chance by a clear margin

export async function halAblationCheck(): Promise<CheckResult> {
  const file = join(process.cwd(), 'scripts', 'hal-ablation', 'data', 'ablation-results.json');
  if (!existsSync(file)) return skip(ID, TITLE, 'no ablation-results.json (run scripts/hal-ablation/run-ablation.ts)', false);

  let data: any;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e: any) { return fail(ID, TITLE, `ablation-results.json unreadable: ${e?.message ?? e}`, false); }

  const byId = (id: string) => (data.results ?? []).find((r: any) => r.scorer === id);
  const A = byId('A_plain_majority'), B = byId('B_HAL_comma'), B0 = byId('B0_ensemble_noComma'), C = byId('C_extractor_prod');
  if (!A || !B) return fail(ID, TITLE, 'ablation results missing A/B scorers', false);

  const detail = {
    quorum_size: data.quorum_size, degraded: data.degraded,
    auc: { A: A.auc, B0: B0?.auc, B: B.auc, C: C?.auc },
    delta_B_minus_A: +(B.auc - A.auc).toFixed(4),
    comma_marginal_auc: B0 ? +(B.auc - B0.auc).toFixed(4) : null,
  };

  if (B.auc < MIN_DISCRIM) return fail(ID, TITLE, `HAL B AUC ${B.auc} below discriminative floor ${MIN_DISCRIM}`, true, detail);
  if (B.auc < A.auc - TOL) return fail(ID, TITLE, `HAL B AUC ${B.auc} < plain-majority A AUC ${A.auc} (beyond ${TOL} tol)`, true, detail);
  return pass(ID, TITLE, `B AUC ${B.auc} ≥ A ${A.auc} (Δ ${detail.delta_B_minus_A}); Comma marginal AUC ${detail.comma_marginal_auc ?? 'n/a'}`, true, detail);
}
