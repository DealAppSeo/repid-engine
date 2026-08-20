/**
 * CHECK — comma verdict is backed by a current ablation. Reads
 * scripts/hal-ablation/data/comma-ablation-results.json (from run-comma-ablation.ts) and reports the
 * decisive B-vs-C held-out result for the Pythagorean-comma-as-cyclic-drift veto. The point: the
 * P-003 re-scope claim can never assert something this artifact contradicts.
 *
 * This is a RECORD check, not a quality gate: B ≈ C (comma value decorative) is a valid scientific
 * outcome (RULE-10), so it does NOT fail the suite. It SKIPs if the ablation artifact is absent
 * (never a silent pass) and FAILs only if the artifact is present but malformed.
 */
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { CheckResult, pass, fail, skip } from '../lib/types';

const ID = 'comma-verdict';
const TITLE = 'Comma-as-cyclic-drift verdict (B vs C held-out, recorded)';

export async function commaVerdictCheck(): Promise<CheckResult> {
  const file = join(process.cwd(), 'scripts', 'hal-ablation', 'data', 'comma-ablation-results.json');
  if (!existsSync(file)) return skip(ID, TITLE, 'no comma-ablation-results.json (run scripts/hal-ablation/run-comma-ablation.ts)', false);
  let d: any;
  try { d = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e: any) { return fail(ID, TITLE, `comma-ablation-results.json unreadable: ${e?.message ?? e}`, false); }

  const lit = d.drift_literal, sh = d.drift_shifted_nonsaturating;
  if (!lit || !sh) return fail(ID, TITLE, 'comma results missing drift verdicts', false);

  const verdict = (v: any) => Math.abs(v.dBC) <= 0.01 ? 'B≈C(decorative)' : v.dBC > 0 ? 'B>C(load-bearing)' : 'B<C(tuned-wins)';
  const detail = {
    quorum_n: d.quorum_n,
    literal: { auc: lit.auc, cvB: lit.cvB, cvC: lit.cvC, dBC: lit.dBC, verdict: verdict(lit) },
    shifted: { auc: sh.auc, cvB: sh.cvB, cvC: sh.cvC, dBC: sh.dBC, verdict: verdict(sh) },
    baselines: d.baselines_auc,
  };
  return pass(ID, TITLE,
    `N=${d.quorum_n} drift AUC lit=${lit.auc}/shift=${sh.auc}; B-vs-C: lit ${verdict(lit)} (Δ${lit.dBC}), shift ${verdict(sh)} (Δ${sh.dBC})`,
    false, detail);
}
