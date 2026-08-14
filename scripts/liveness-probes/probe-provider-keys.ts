/**
 * probe-provider-keys.ts — is each LLM provider key ALIVE, not merely PRESENT?
 *
 * A key can be set everywhere and still be dead. HUGGINGFACE_API_TOKEN was
 * present in .env.master AND on the deployed service while HuggingFace answered
 * "not supported by any provider you have enabled" — an entitlement failure, not
 * auth. Every presence check said fine; it took the whole LLM broker down (503)
 * because the dead provider sat at the cheapest tier. Presence-based filtering
 * cannot catch that class at all. So: probe, don't check.
 *
 * It also cost real time the other way round. A stale GROQ key made the
 * golden-math tripwire fail, and the failure looked exactly like a drop in math
 * accuracy. Knowing which keys are dead BEFORE reading a quality result is the
 * difference between a five-minute fix and an afternoon hunting a scoring bug.
 *
 * SECRETS DISCIPLINE — this script prints key NAMES and STATUS. It never prints,
 * logs, or writes a key VALUE, not even a prefix. Read it before trusting it.
 *
 * This is also the primitive BYOK needs: before storing a user's provider key we
 * must know it works, or we accept a key that fails on their first real call and
 * teaches them the product is broken.
 *
 *   npx ts-node scripts/liveness-probes/probe-provider-keys.ts
 *   npx ts-node scripts/liveness-probes/probe-provider-keys.ts --json
 *
 * Exit code is 0 even with dead keys — this reports, it does not gate. An
 * INCONCLUSIVE result (network/timeout) is never reported as DEAD: recommending
 * a rotation off a flaky probe is how you burn a working key and an afternoon.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  PROVIDER_PROBES, probeProviderKey, independentFamilies, resolveProbeKey, type KeyProbeStatus,
} from '../../src/services/provider-key-probe';

/**
 * The probe table and the LIVE/DEAD/INCONCLUSIVE mapping live in
 * src/services/provider-key-probe.ts, NOT here. BYOK custody refuses to store a
 * key this same code has not seen work, and two copies would drift — an ops
 * report that disagrees with the BYOK gate about whether a key is dead is worse
 * than having neither.
 */
type Status = KeyProbeStatus | 'ABSENT';

/** Reads .env.master WITHOUT importing it into process.env, so nothing downstream can leak it. */
function loadMasterEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    out[name!] = (rest ?? '').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function probeOne(env: string, provider: string, key: string | undefined): Promise<{ status: Status; detail: string }> {
  if (!key) return { status: 'ABSENT', detail: 'not set' };
  return probeProviderKey(provider, key);
}

async function main() {
  const asJson = process.argv.includes('--json');
  const master = loadMasterEnv(resolve(process.cwd(), '..', '.env.master'));
  // Process env wins: it is what a deployed service would actually use.
  const keyFor = (name: string) => process.env[name] || master[name];

  const results = await Promise.all(
    PROVIDER_PROBES.map(async (p) => {
      // Resolve across every name the probe accepts, not just the canonical one — a key set under
      // a legacy alias is present, and reporting it "not set" is the #398 failure as a green row.
      const found = resolveProbeKey(p, keyFor);
      const { status, detail } = await probeOne(p.env, p.provider, found?.key);
      // Report the name that actually answered, so a legacy alias is visible in the output.
      return { key: found?.name ?? p.env, provider: p.provider, family: p.family, status, detail };
    }),
  );

  if (asJson) {
    console.log(JSON.stringify({ probed_at: new Date().toISOString(), results }, null, 2));
    return;
  }

  const pad = Math.max(...results.map((r) => r.key.length));
  const mark: Record<Status, string> = { LIVE: '  LIVE', DEAD: '  DEAD', INCONCLUSIVE: '  ????', ABSENT: 'ABSENT' };
  console.log('\nProvider key liveness — probed, not presence-checked. Values never printed.\n');
  for (const r of results) {
    console.log(`  ${mark[r.status]}  ${r.key.padEnd(pad)}  ${r.family.padEnd(8)}  ${r.detail}`);
  }

  // The number that actually matters for HAL: how many INDEPENDENT families are
  // reachable. Quorum counts families, so 5 live keys across 2 families is a
  // 2-family fleet, and any accuracy claim measured wider than that is unreadable.
  const liveFamilies = independentFamilies(results.filter((r) => r.status === 'LIVE').map((r) => r.provider));
  console.log(`\n  Independent families reachable: ${liveFamilies.length} [${liveFamilies.join(', ')}]`);
  console.log('  (\'mixed\' hosts are excluded — they resell several families and cannot be counted as one independent vote.)');

  const dead = results.filter((r) => r.status === 'DEAD');
  const unsure = results.filter((r) => r.status === 'INCONCLUSIVE');
  if (dead.length) console.log(`\n  DEAD (credential rejected — safe to rotate): ${dead.map((d) => d.key).join(', ')}`);
  if (unsure.length) console.log(`  INCONCLUSIVE (do NOT rotate on this evidence): ${unsure.map((d) => d.key).join(', ')}`);
  console.log('');
}

main().catch((e) => {
  console.error('probe failed:', (e as Error)?.message ?? String(e));
  process.exit(1);
});
