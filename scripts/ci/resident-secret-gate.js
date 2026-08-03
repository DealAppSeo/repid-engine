#!/usr/bin/env node
/**
 * resident-secret-gate.js — fail CI on a secret that is IN the repo, not just one
 * arriving in this diff.
 *
 * WHY THIS EXISTS. `gitleaks-action@v2` scans the commits in the push/PR range. That
 * is the right gate for incoming secrets and structurally blind to resident ones: on
 * 2026-08-03 a LIVE Supabase `service_role` key for Trinity production (exp 2035) sat
 * in a tracked `service_role.txt`, and every gitleaks check on every PR was green —
 * several logged "0 commits scanned". Green was being read as "no secrets in the
 * repo", which the range scan never claimed.
 *
 * WHY A RATCHET AND NOT A HARD FAIL. A full-tree scan of this repo currently reports
 * 28 findings, essentially all `generic-api-key` on x402 test fixtures and EIP-712
 * constants. Landing a hard gate would go red on day one and get switched off within a
 * week, which is worse than no gate. So the gate is a RATCHET: the current findings are
 * baselined per file, and the build fails on
 *
 *   (a) any finding in a file NOT on the baseline — a new file leaking is always new, and
 *   (b) any increase in the total count — more findings in a known file is also new.
 *
 * The baseline can only shrink. Removing an entry is the only allowed edit; adding one
 * requires a human writing down why, in the same commit.
 *
 * WHY FILES AND NOT FINGERPRINTS. Gitleaks fingerprints embed line numbers, so they
 * break on any edit above them and the baseline decays into noise that gets bulk-
 * regenerated — which silently re-admits real findings. A file+count pair survives
 * refactors and still refuses genuinely new leaks.
 *
 * Usage:  node scripts/ci/resident-secret-gate.js <gitleaks-report.json>
 */

const { readFileSync } = require('node:fs');
const { relative, sep } = require('node:path');

/**
 * KNOWN RESIDENT FINDINGS — 2026-08-03. Repo-relative paths, POSIX separators.
 *
 * Every entry is DEBT, not an exemption: each is a test fixture or protocol constant
 * that trips `generic-api-key` and should eventually be moved behind a fixture helper
 * so this list reaches zero. None of them is a credential for a live system — that was
 * verified by decoding each one at baseline time. If you are adding to this list, you
 * are almost certainly committing a secret.
 */
const BASELINE = {
  'scripts/x402/preflight-real-microtx.ts': 1,
  'src/services/hal-tester.ts': 1,
  'src/services/reputation/__tests__/repid-sync-aggregator.test.ts': 2,
  'src/services/x402-outbound-client.ts': 2,
  'src/services/x402-real-settler.ts': 2,
  'src/services/x402-recovery-worker.ts': 1,
  'tests/integration/x402-failure-modes.integration.test.ts': 2,
  'tests/integration/x402-mock-harness.integration.test.ts': 2,
  'tests/integration/x402-recovery-flow.integration.test.ts': 2,
  'tests/peer-verification.test.ts': 2,
  'tests/reponomics-real-staking.test.ts': 1,
  'tests/reponomics-withdraw-fail-closed.test.ts': 1,
  'tests/services/x402-circuit-breaker.test.ts': 1,
  'tests/services/x402-governor.test.ts': 7,
};

const BASELINE_TOTAL = Object.values(BASELINE).reduce((a, b) => a + b, 0); // 27

/** Normalise a gitleaks `File` (absolute, OS-native) to a repo-relative POSIX path. */
function normalisePath(file, root = process.cwd()) {
  const rel = file.startsWith('/') || /^[A-Za-z]:/.test(file) ? relative(root, file) : file;
  return rel.split(sep).join('/').replace(/^\.\//, '');
}

/**
 * Compare a scan against the baseline.
 *
 * Pure so it can be unit-tested without running gitleaks. Returns the two independent
 * violation classes separately, because they mean different things to whoever reads the
 * failure: an unknown file is "you committed a secret", a count rise is "a known-noisy
 * file got noisier and someone needs to look".
 */
function evaluateScan(findings, baseline = BASELINE, root = process.cwd()) {
  const counts = {};
  for (const f of findings) {
    const p = normalisePath(f.File ?? f.file ?? '', root);
    counts[p] = (counts[p] ?? 0) + 1;
  }

  const unknownFiles = Object.keys(counts)
    .filter((p) => !(p in baseline))
    .sort();

  const grownFiles = Object.keys(counts)
    .filter((p) => p in baseline && counts[p] > baseline[p])
    .map((p) => ({ file: p, was: baseline[p], now: counts[p] }))
    .sort((a, b) => a.file.localeCompare(b.file));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0);

  // Findings the baseline expects that are no longer there — the ratchet tightening.
  const cleared = Object.keys(baseline)
    .filter((p) => (counts[p] ?? 0) < baseline[p])
    .map((p) => ({ file: p, was: baseline[p], now: counts[p] ?? 0 }));

  return {
    pass: unknownFiles.length === 0 && grownFiles.length === 0,
    unknownFiles,
    grownFiles,
    cleared,
    total,
    baseTotal,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

module.exports = { evaluateScan, normalisePath, BASELINE };

// Run the gate only when invoked directly, so `require` from a test is side-effect free.
const isMain = require.main === module;
if (isMain) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('usage: resident-secret-gate.js <gitleaks-report.json>');
    process.exit(2);
  }

  let findings;
  try {
    const raw = readFileSync(reportPath, 'utf8').trim();
    // gitleaks writes an empty file (not "[]") when it finds nothing.
    findings = raw.length === 0 ? [] : JSON.parse(raw);
  } catch (e) {
    // FAIL CLOSED. An unreadable report is not a clean report — that conflation is the
    // whole failure mode this gate exists to correct.
    console.error(`[resident-secrets] cannot read ${reportPath}: ${e.message}`);
    console.error('[resident-secrets] treating an unreadable scan as FAILURE, not as clean.');
    process.exit(1);
  }

  const r = evaluateScan(findings);

  console.log(`[resident-secrets] ${r.total} findings in the tree (baseline ${r.baseTotal}).`);

  if (r.cleared.length > 0) {
    console.log('[resident-secrets] ratchet tightened — update BASELINE in this file:');
    for (const c of r.cleared) console.log(`  ${c.file}: ${c.was} -> ${c.now}`);
  }

  if (r.pass) {
    console.log('[resident-secrets] PASS — no findings outside the recorded baseline.');
    process.exit(0);
  }

  console.error('');
  console.error('[resident-secrets] FAIL — a secret is present in the repository tree.');
  if (r.unknownFiles.length > 0) {
    console.error('');
    console.error('  Findings in files with NO baseline entry:');
    for (const f of r.unknownFiles) console.error(`    ${f}`);
    console.error('');
    console.error('  Remove the secret and ROTATE it. A secret in git history is leaked');
    console.error('  even after the file is deleted — deletion is not rotation.');
  }
  if (r.grownFiles.length > 0) {
    console.error('');
    console.error('  Known-noisy files that gained findings:');
    for (const g of r.grownFiles) console.error(`    ${g.file}: ${g.was} -> ${g.now}`);
  }
  console.error('');
  console.error('  Do NOT fix this by adding a BASELINE entry unless you have decoded the');
  console.error('  value and confirmed it is not a credential for a live system.');
  process.exit(1);
}
