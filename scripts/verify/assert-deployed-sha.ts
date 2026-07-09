/**
 * verify:deployed-sha — deploy-drift guard. Defeats the "green ≠ deployed" hazard.
 *
 * Railway keeps the last SUCCESSFUL build serving when a new deploy FAILS, so the
 * /health dot can read "ok" on stale code — a merged fix reads "live" but never runs.
 * This script curls the live /health, reads `deployed_commit` (RAILWAY_GIT_COMMIT_SHA
 * injected at build time), and compares it to the expected commit (origin/main HEAD by
 * default). If they differ, the deployed code is stale vs the target → exit non-zero.
 *
 * Usage:
 *   npm run verify:deployed-sha
 *   npm run verify:deployed-sha -- --url https://repid-engine-production.up.railway.app/health
 *   npm run verify:deployed-sha -- --expected <sha>        # assert against an explicit SHA
 *   npm run verify:deployed-sha -- --ref origin/main       # assert against a git ref (default)
 *
 * Env overrides (CI-friendly):
 *   HEALTH_URL       — live /health URL to probe
 *   EXPECTED_SHA     — explicit commit SHA to require (skips git)
 *   EXPECTED_REF     — git ref to resolve for the expected SHA (default: origin/main)
 *
 * Exit codes:
 *   0  match (deployed == expected), OR deployed is 'unknown' with --allow-unknown
 *   1  DRIFT — deployed != expected (deployed code is stale)
 *   2  could not determine one side (health unreachable, no deployed_commit field,
 *      git ref unresolvable) — an inconclusive check, never a silent pass
 *
 * NOTE (chicken-and-egg): this only becomes meaningful once a build carrying the new
 * /health (with `deployed_commit`) is actually deployed. Until then the live endpoint
 * has no `deployed_commit` field → this reports INCONCLUSIVE (exit 2), not a false pass.
 */
import { execSync } from 'child_process';

const DEFAULT_URL = 'https://repid-engine-production.up.railway.app/health';
const DEFAULT_REF = 'origin/main';

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  return undefined;
}

const hasFlag = (flag: string): boolean => process.argv.includes(flag);

async function main(): Promise<number> {
  const url = getArg('--url') || process.env.HEALTH_URL || DEFAULT_URL;
  const explicitExpected = getArg('--expected') || process.env.EXPECTED_SHA;
  const ref = getArg('--ref') || process.env.EXPECTED_REF || DEFAULT_REF;
  const allowUnknown = hasFlag('--allow-unknown');

  // 1. Resolve the EXPECTED sha (explicit wins; otherwise resolve the git ref).
  let expected: string;
  if (explicitExpected) {
    expected = explicitExpected.trim();
  } else {
    try {
      expected = execSync(`git rev-parse ${ref}`, { encoding: 'utf8' }).trim();
    } catch (e: any) {
      console.error(`❌ INCONCLUSIVE: could not resolve git ref '${ref}'.`);
      console.error(`   ${e?.message ?? e}`);
      console.error(`   Hint: run 'git fetch origin' first, or pass --expected <sha>.`);
      return 2;
    }
  }

  // 2. Fetch the live /health and read the deployed commit.
  let deployed: string | undefined;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) {
      console.error(`❌ INCONCLUSIVE: ${url} returned HTTP ${resp.status}.`);
      return 2;
    }
    const body: any = await resp.json();
    deployed = body?.deployed_commit;
  } catch (e: any) {
    console.error(`❌ INCONCLUSIVE: could not reach ${url}.`);
    console.error(`   ${e?.message ?? e}`);
    return 2;
  }

  if (deployed === undefined || deployed === null) {
    console.error(`❌ INCONCLUSIVE: live /health has no 'deployed_commit' field.`);
    console.error(`   The build serving ${url} predates this field — deploy the new`);
    console.error(`   /health, then this check becomes meaningful (chicken-and-egg).`);
    return 2;
  }

  const short = (s: string) => (s === 'unknown' ? s : s.slice(0, 7));

  if (deployed === 'unknown') {
    const msg =
      `⚠️  deployed_commit is 'unknown' — RAILWAY_GIT_COMMIT_SHA / GIT_COMMIT_SHA not set on the deploy.`;
    if (allowUnknown) {
      console.warn(msg + ' (--allow-unknown: not failing)');
      return 0;
    }
    console.error(`❌ ${msg}`);
    console.error(`   Cannot verify against expected ${short(expected)}. Fix the env var or pass --allow-unknown.`);
    return 2;
  }

  // 3. Compare.
  console.log(`expected (${ref === DEFAULT_REF && !explicitExpected ? ref : (explicitExpected ? 'explicit' : ref)}): ${expected}`);
  console.log(`deployed (${url}):`);
  console.log(`          ${deployed}`);

  if (deployed === expected) {
    console.log(`✅ MATCH — live deploy is at ${short(deployed)}; no drift.`);
    return 0;
  }

  console.error(
    `❌ DRIFT — deployed ${short(deployed)} != expected ${short(expected)}. ` +
      `The live service is running STALE code (a newer build likely failed and Railway ` +
      `kept the last successful one up). Confirm the deployment status, not the health dot.`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('❌ INCONCLUSIVE: unexpected error', e);
    process.exit(2);
  });
