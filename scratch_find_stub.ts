const comma = 531441 / 524288;
const target = 0.376061651;
const tol = 1e-6;

console.log('Target value:', target / comma);

for (let harm = 0; harm <= 1; harm += 0.01) {
  for (let epi = 0; epi <= 1; epi += 0.01) {
    for (let evi = 0; evi <= 1; evi += 0.01) {
      for (let scope = 0; scope <= 1; scope += 0.01) {
        const h = Math.round(harm*100)/100;
        const e = Math.round(epi*100)/100;
        const v = Math.round(evi*100)/100;
        const s = Math.round(scope*100)/100;
        const val = 0.4*h + 0.3*e + 0.2*(1-v) + 0.1*(1-s);
        if (Math.abs(val * comma - target) < tol) {
          console.log(`Found: harm=${h}, epi=${e}, evi=${v}, scope=${s}`);
        }
      }
    }
  }
}
