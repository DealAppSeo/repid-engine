/**
 * provider-doctor.ts — does the ROUTER's picture of the fleet match reality?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS ADDS OVER probe-provider-keys.ts
 * ════════════════════════════════════════════════════════════════════════════════
 * The existing probe answers "is this key alive?" — one provider at a time, in
 * isolation. It is correct and this script reuses it wholesale.
 *
 * The question it does NOT answer is the one that actually caused an outage:
 * **does the router's configuration agree with what the probe just found?**
 *
 * `LLM_DISABLED_PROVIDERS` is a hand-maintained env string. Nothing keeps it in
 * step with reality. On 2026-08-01 HUGGINGFACE_API_TOKEN was set everywhere and
 * dead, sitting at the cheapest tier, and it took the LLM broker down — not
 * because the key was unknowable, but because nothing compared what the probe
 * could see against what the router believed.
 *
 * So this reports a DIFF, and it prescribes the exact env change to close it:
 *
 *   DEAD but NOT disabled   → the router will keep routing real traffic there.
 *                             This is the outage shape. Add it to the list.
 *   disabled but LIVE       → a working provider is being wasted, and if it was
 *                             carrying an independent family, HAL lost quorum
 *                             width for nothing. Consider removing it.
 *   DEAD and disabled       → correctly handled. Nothing to do.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IT PRESCRIBES, IT DOES NOT APPLY
 * ════════════════════════════════════════════════════════════════════════════════
 * The fix is printed as the env line to set. This script never writes env, never
 * calls Railway, never mutates anything. Which providers are entitled is an
 * account fact, and a script that silently rewrote the routing table from a probe
 * it ran once would be exactly the kind of automatic action that turns a flaky
 * network into a self-inflicted outage.
 *
 * FAMILY WIDTH IS REPORTED FIRST-CLASS. HAL counts INDEPENDENT families, not
 * hosts, so "9 providers live" can still be a narrow quorum. Resellers ('mixed')
 * are never counted as an independent vote.
 *
 * SECRETS: prints provider NAMES, env var NAMES and STATUS only. Never a key
 * value, never a prefix. It reads env vars solely to hand them to the probe.
 *
 *   npx tsx scripts/liveness-probes/provider-doctor.ts
 *   npx tsx scripts/liveness-probes/provider-doctor.ts --json
 *
 * Exit code: 0 when config matches reality (or only wastes a live provider),
 *            1 when a DEAD provider is still routable — the actionable case.
 * INCONCLUSIVE never drives the exit code: a timeout is not evidence about a key.
 */

import { PROVIDER_PROBES, independentFamilies } from '../../src/services/provider-key-probe';
import { refreshFleetLiveness, getVerdicts, DEFAULT_MIN_FAMILIES } from '../../src/providers/provider-liveness';

const asJson = process.argv.includes('--json');

/** Mirrors src/providers/router.ts disabledProviders() — same parse, same casing. */
function disabledFromEnv(): string[] {
  return (process.env['LLM_DISABLED_PROVIDERS'] ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

interface Row {
  provider: string;
  env: string;
  family: string;
  status: 'LIVE' | 'DEAD' | 'INCONCLUSIVE' | 'ABSENT';
  detail: string;
  disabled: boolean;
  /** The actionable classification. */
  verdict: 'ok' | 'dead_but_routable' | 'disabled_but_live' | 'not_configured';
}

async function main() {
  const disabled = new Set(disabledFromEnv());

  await refreshFleetLiveness();
  const byProvider = new Map(getVerdicts().map((v) => [v.provider, v]));

  const rows: Row[] = PROVIDER_PROBES.map((p) => {
    const v = byProvider.get(p.provider);
    const status: Row['status'] = v ? v.status : 'ABSENT';
    const isDisabled = disabled.has(p.provider);

    let verdict: Row['verdict'] = 'ok';
    if (status === 'ABSENT') verdict = 'not_configured';
    else if (status === 'DEAD' && !isDisabled) verdict = 'dead_but_routable';
    else if (status === 'LIVE' && isDisabled) verdict = 'disabled_but_live';

    return {
      provider: p.provider,
      env: p.env,
      family: p.family,
      status,
      detail: v?.detail ?? 'env var not set',
      disabled: isDisabled,
      verdict,
    };
  });

  const deadButRoutable = rows.filter((r) => r.verdict === 'dead_but_routable');
  const disabledButLive = rows.filter((r) => r.verdict === 'disabled_but_live');

  // Width the router can actually reach: LIVE and not disabled.
  const reachable = rows.filter((r) => r.status === 'LIVE' && !r.disabled).map((r) => r.provider);
  const families = independentFamilies(reachable);

  // What the disable-list SHOULD say to match what was just observed. Existing
  // entries are preserved unless the probe positively found them LIVE — an
  // INCONCLUSIVE or ABSENT provider is never silently un-disabled.
  const prescribed = [...new Set([
    ...[...disabled].filter((d) => !disabledButLive.some((r) => r.provider === d)),
    ...deadButRoutable.map((r) => r.provider),
  ])].sort();

  if (asJson) {
    console.log(JSON.stringify({
      rows,
      reachableProviders: reachable,
      independentFamilies: families,
      minFamiliesFloor: DEFAULT_MIN_FAMILIES,
      deadButRoutable: deadButRoutable.map((r) => r.provider),
      disabledButLive: disabledButLive.map((r) => r.provider),
      prescribedDisabledProviders: prescribed,
    }, null, 2));
  } else {
    console.log('\n=== PROVIDER DOCTOR — router config vs probed reality ===\n');
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(`  ${pad('PROVIDER', 14)}${pad('FAMILY', 10)}${pad('STATUS', 15)}${pad('DISABLED', 10)}DETAIL`);
    console.log(`  ${'-'.repeat(72)}`);
    for (const r of rows) {
      const mark = r.verdict === 'dead_but_routable' ? ' <== ROUTABLE AND DEAD'
        : r.verdict === 'disabled_but_live' ? ' <== wasted (live but disabled)'
        : '';
      console.log(`  ${pad(r.provider, 14)}${pad(r.family, 10)}${pad(r.status, 15)}${pad(r.disabled ? 'yes' : 'no', 10)}${r.detail}${mark}`);
    }

    console.log(`\n  Reachable providers: ${reachable.length ? reachable.join(', ') : 'NONE'}`);
    console.log(`  Independent families: ${families.length} (${families.join(', ') || 'none'}) · floor ${DEFAULT_MIN_FAMILIES}`);
    if (families.length < DEFAULT_MIN_FAMILIES) {
      console.log(`  WARNING: independent family width is below the floor. HAL counts families, not hosts —`);
      console.log(`           a verdict from this fleet is narrower than the provider count suggests.`);
    }

    if (deadButRoutable.length === 0 && disabledButLive.length === 0) {
      console.log('\n  Config matches reality. Nothing to change.\n');
    } else {
      console.log('\n  --- PRESCRIPTION (not applied) ---');
      if (deadButRoutable.length > 0) {
        console.log(`\n  ${deadButRoutable.length} provider(s) are DEAD but still routable. This is the outage shape:`);
        for (const r of deadButRoutable) console.log(`    - ${r.provider} (${r.env}): ${r.detail}`);
      }
      if (disabledButLive.length > 0) {
        console.log(`\n  ${disabledButLive.length} provider(s) are disabled but LIVE — wasted capacity:`);
        for (const r of disabledButLive) {
          const f = r.family === 'mixed' ? 'reseller, no independent vote' : `family '${r.family}'`;
          console.log(`    - ${r.provider} (${f})`);
        }
      }
      console.log('\n  Set on the repid-engine service to match what was just probed:');
      console.log(`\n    LLM_DISABLED_PROVIDERS=${prescribed.join(',')}\n`);
      console.log('  Review before applying — entitlement is an account fact, and one probe run is');
      console.log('  a snapshot. INCONCLUSIVE providers were left exactly as they are.\n');
    }
  }

  process.exit(deadButRoutable.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[provider-doctor] fatal:', e?.message ?? e);
  process.exit(2);
});
