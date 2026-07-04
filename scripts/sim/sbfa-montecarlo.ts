/**
 * sbfa-montecarlo.ts — Monte Carlo model of the SBFA / BFT verifier quorum.
 *
 * QUESTION (Sean's thesis): does an SBFA (decorrelated) BFT (k-of-n) validator
 * quorum make recall *increase and hold* as independent families are added — and
 * how much does inter-family CORRELATION (the "fracture" axis) erode that gain?
 *
 * THIS IS A MODEL, NOT A MEASUREMENT. Every per-family number is a stated
 * assumption (calibrated to observed HAL behavior where noted). It predicts a
 * regime and a shape; it does not claim a production F1. Live validation is the
 * separate harness (run-hal-validation.ts). Treat outputs as "belief, quantified."
 *
 * Model: Gaussian-copula correlated binary votes. Each family i emits a FALSE
 * vote iff a latent score sqrt(rho)*Z + sqrt(1-rho)*E_i exceeds a truth-dependent
 * threshold, where Z is a shared factor (induces correlation rho) and E_i is
 * independent. Thresholds are set so each family's marginals match:
 *   sensitivity s = P(vote FALSE | item IS a hallucination)
 *   fallout     f = P(vote FALSE | item is truthful)
 * Decision: veto iff (#FALSE votes) >= k. We report recall, precision, F1, and
 * run-to-run stability (the "hold").
 *
 * Run:  npx ts-node scripts/sim/sbfa-montecarlo.ts
 *       CALIB_RECALL=0... CALIB_PRECISION=0.. npx ts-node scripts/sim/sbfa-montecarlo.ts
 */

// ---- deterministic RNG (mulberry32) + Box-Muller Gaussian ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// inverse normal CDF (Acklam's rational approximation)
function invNorm(p: number): number {
  if (p <= 0) return -38; if (p >= 1) return 38;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425, ph = 1 - pl;
  let q: number, r: number;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1); }
  if (p <= ph) { q = p - 0.5; r = q*q; return (((((a[0]!*r+a[1]!)*r+a[2]!)*r+a[3]!)*r+a[4]!)*r+a[5]!)*q / (((((b[0]!*r+b[1]!)*r+b[2]!)*r+b[3]!)*r+b[4]!)*r+1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]!*q+c[1]!)*q+c[2]!)*q+c[3]!)*q+c[4]!)*q+c[5]!) / ((((d[0]!*q+d[1]!)*q+d[2]!)*q+d[3]!)*q+1);
}

interface Cfg { n: number; k: number; s: number; f: number; rho: number; prevalence: number; N: number; seed: number; }
interface Res { recall: number; precision: number; f1: number; }

function simulate(c: Cfg): Res {
  const rng = mulberry32(c.seed);
  const thrH = invNorm(1 - c.s);
  const thrT = invNorm(1 - c.f);
  let tp = 0, fp = 0, fn = 0;
  for (let j = 0; j < c.N; j++) {
    const isHall = rng() < c.prevalence;
    const thr = isHall ? thrH : thrT;
    const Z = gaussian(rng);
    let falseVotes = 0;
    for (let i = 0; i < c.n; i++) {
      const latent = Math.sqrt(c.rho) * Z + Math.sqrt(1 - c.rho) * gaussian(rng);
      if (latent > thr) falseVotes++;
    }
    const veto = falseVotes >= c.k;
    if (isHall && veto) tp++;
    else if (isHall && !veto) fn++;
    else if (!isHall && veto) fp++;
  }
  const recall = tp / (tp + fn || 1);
  const precision = tp / (tp + fp || 1);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { recall, precision, f1 };
}

// average over seeds + report stability (the "hold")
function run(cfg: Omit<Cfg, "seed">, seeds = 12): { recall: number; precision: number; f1: number; recallSd: number } {
  const rs: number[] = [], ps: number[] = [], fs: number[] = [];
  for (let s = 0; s < seeds; s++) { const r = simulate({ ...cfg, seed: 1000 + s * 7 }); rs.push(r.recall); ps.push(r.precision); fs.push(r.f1); }
  const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const sd = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); };
  return { recall: mean(rs), precision: mean(ps), f1: mean(fs), recallSd: sd(rs) };
}

// Calibrate (s,f) to a target (recall, precision) at a reference config via grid search.
function calibrate(targetRecall: number, targetPrecision: number, refN: number, refK: number, rho: number, prevalence: number): { s: number; f: number } {
  let best = { s: 0.5, f: 0.1, err: Infinity };
  for (let s = 0.30; s <= 0.99; s += 0.01) {
    for (let f = 0.005; f <= 0.30; f += 0.005) {
      const r = run({ n: refN, k: refK, s, f, rho, prevalence, N: 8000 }, 4);
      const err = (r.recall - targetRecall) ** 2 + (r.precision - targetPrecision) ** 2;
      if (err < best.err) best = { s, f, err };
    }
  }
  return { s: best.s, f: best.f };
}

function main() {
  const prevalence = Number(process.env.PREVALENCE ?? 0.488); // hallucination base rate (~488/1000 in the corpus)
  const N = 20000;
  // Anchor to the measured clean 2-decisive-family run (groq+deepseek). Override via env once known.
  const targetRecall = Number(process.env.CALIB_RECALL ?? 0.45);
  const targetPrecision = Number(process.env.CALIB_PRECISION ?? 0.85);
  console.log(`\n=== SBFA / BFT quorum Monte Carlo (MODEL — stated assumptions, not a prod metric) ===`);
  console.log(`prevalence=${prevalence}  N=${N}/config  calibration target: recall≈${targetRecall} precision≈${targetPrecision} @ n=2,k=2,rho=0`);
  const { s, f } = calibrate(targetRecall, targetPrecision, 2, 2, 0, prevalence);
  console.log(`calibrated per-family: sensitivity s=${s.toFixed(2)}  fallout f=${f.toFixed(3)}  (each family, independent)\n`);

  // Sweep: family count n with a majority rule (k = ceil((n+1)/2)), across correlation rho.
  const rhos = [0.0, 0.3, 0.6, 0.9];
  console.log(`--- MAJORITY rule k=ceil((n+1)/2): recall (±sd) | precision | F1 ---`);
  console.log(`n \\ rho `.padEnd(10) + rhos.map((r) => `rho=${r}`.padEnd(22)).join(""));
  for (const n of [1, 2, 3, 5, 7]) {
    const k = Math.ceil((n + 1) / 2);
    let line = `n=${n} k=${k}`.padEnd(10);
    for (const rho of rhos) {
      const r = run({ n, k, s, f, rho, prevalence, N });
      line += `${(r.recall * 100).toFixed(1)}±${(r.recallSd * 100).toFixed(1)} P${(r.precision * 100).toFixed(0)} F${(r.f1 * 100).toFixed(0)}`.padEnd(22);
    }
    console.log(line);
  }

  // The current production reality: 2 families where one (cerebras) is dead-weight ~ effectively 1 decisive.
  console.log(`\n--- Regimes of interest ---`);
  const scen = [
    { label: "today: 2 fam, 1 dead-weight (~1 decisive), unanimous k=2", n: 1, k: 1, rho: 0, sMul: 1 },
    { label: "today+deepseek: 2 decisive fam, unanimous k=2, decorrelated", n: 2, k: 2, rho: 0, sMul: 1 },
    { label: "3 decisive fam, 2-of-3 BFT, decorrelated (rho=0)", n: 3, k: 2, rho: 0, sMul: 1 },
    { label: "3 decisive fam, 2-of-3 BFT, CORRELATED (rho=0.6)", n: 3, k: 2, rho: 0.6, sMul: 1 },
    { label: "5 decisive fam, 3-of-5 BFT, decorrelated", n: 5, k: 3, rho: 0, sMul: 1 },
  ];
  for (const sc of scen) {
    const r = run({ n: sc.n, k: sc.k, s, f, rho: sc.rho, prevalence, N });
    console.log(`  ${sc.label}`);
    console.log(`      recall ${(r.recall * 100).toFixed(1)}% (±${(r.recallSd * 100).toFixed(1)})  precision ${(r.precision * 100).toFixed(1)}%  F1 ${(r.f1 * 100).toFixed(1)}%`);
  }
  console.log(`\nReading: at low correlation, recall rises AND its run-to-run sd shrinks as families are`);
  console.log(`added (increase + hold). At high rho, extra families are near-redundant — the "fracture"`);
  console.log(`(decorrelation) is what converts more validators into more truth. [MODEL, not prod]`);
}

main();
