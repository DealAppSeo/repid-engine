/**
 * verify:quality-hook — can the service quality hook ever produce an observation?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES [FOUND 2026-09-04, one day after the hook merged]
 * ════════════════════════════════════════════════════════════════════════════════
 * The hook's enrolment allowlist was chosen by measuring "the most active agents
 * on service contracts". That measurement answered for the BUYER. The hook keys
 * on `providerAgentId`, and the agent named there had fulfilled exactly ONE
 * contract, two months earlier.
 *
 * So the hook merged, deployed, and was structurally incapable of producing a
 * single observation — at any flag setting, forever. Every fulfilment would have
 * reported `agent_not_enrolled`, which reads like a deliberate skip rather than a
 * misconfiguration.
 *
 * NOTHING FAILED. Tests were green (they pin the allowlist's SIZE, which was
 * right), the deploy was healthy, and the hook logged nothing because in `off`
 * mode it correctly does no I/O. The only visible symptom was an absence — zero
 * observations — and an absence has a dozen innocent explanations. That is why
 * this is a script and not a unit test: the fact it needs lives in the database,
 * and no test with a mocked client can see it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GENERAL SHAPE, which is worth more than this instance
 * ════════════════════════════════════════════════════════════════════════════════
 * A gate whose allowlist cannot match anything it gates is invisible from every
 * direction: the code is correct, the config is well-formed, the flag is honoured,
 * and the result is silence that looks like "switched off on purpose". Anywhere a
 * list of names is compared against live data, something should ask whether the
 * list can ever match. "Most active agent" is not a fact until you say active AT
 * WHAT — a table carrying both `provider_agent_id` and `buyer_agent_id` will
 * happily answer the question you did not mean to ask.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IT REPORTS. IT CHANGES NOTHING.
 * ════════════════════════════════════════════════════════════════════════════════
 * No writes, no flag flips, no enrolment edits. Who is enrolled decides whose
 * reputation a HAL verdict can move, so widening it is a decision with an owner.
 *
 * Exit codes follow the repo's three-outcome convention:
 *   0  VERIFIED    — every enrolled agent is a real provider on this path
 *   1  FAILED      — an enrolled agent has never delivered on this path, or has
 *                    gone quiet past the stale window. Both mean a name in the
 *                    allowlist is not doing what enrolling it implied.
 *   2  NOT_CHECKED — could not reach the database. Never a silent pass.
 *
 * Usage:  npm run verify:quality-hook [-- --stale-days 30]
 */
import { serviceQualityConfig, serviceQualityStatus } from '../../src/services/service-quality-hook';

async function loadDb(): Promise<{ db: any } | { err: string }> {
  try {
    // `require`, not dynamic `import()` — both `src/db.ts` and a `src/db/` directory
    // exist, and `import()` resolves the DIRECTORY at runtime and throws. See the
    // same note in vesting-not-stranded.ts, where that mistake reported NOT_CHECKED
    // unconditionally and turned the checker into the thing it checks for.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { db: require('../../src/db').db };
  } catch (e: any) {
    return { err: e?.message ?? String(e) };
  }
}

/** How long an enrolled provider may go without delivering before it counts as stale. */
function staleDays(): number {
  const i = process.argv.indexOf('--stale-days');
  const fromArgv = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  const fromEnv = Number(process.env['QUALITY_HOOK_STALE_DAYS']);
  const v = Number.isFinite(fromArgv) ? fromArgv : Number.isFinite(fromEnv) ? fromEnv : 30;
  return Math.max(1, v);
}

interface ProviderStat {
  agent_name: string;
  fulfilled: number;
  last_fulfilled: string | null;
}

async function main(): Promise<number> {
  const stale = staleDays();
  const { mode, agents } = serviceQualityConfig();
  const status = serviceQualityStatus();

  console.log(
    `service quality hook: mode=${status.mode} enrolled=${status.enrolled_count} ` +
      `allowlist=${status.allowlist}`,
  );
  console.log(`enrolled: ${[...agents].join(', ') || '(nobody)'}`);

  // An empty allowlist is not "fine because the hook is off". It means that
  // whenever someone DOES turn the flag on, nothing happens and the absence looks
  // deliberate. The flag state is reported, never used to excuse the check.
  if (agents.size === 0) {
    console.error(
      '❌ FAILED — the enrolled set is EMPTY. The hook would evaluate nobody at any ' +
        'flag setting. An empty allowlist is a misconfiguration, not a safe default.',
    );
    return 1;
  }

  const loaded = await loadDb();
  if ('err' in loaded) {
    console.error(
      `⚠️  NOT_CHECKED — no database client (${loaded.err}). Export SUPABASE_URL and a ` +
        'service key to run this against real data.',
    );
    return 2;
  }
  const db = loaded.db;

  // The join is the whole point: count contracts where the agent is the PROVIDER.
  // Counting rows where it merely appears would reproduce the original bug.
  const { data: contracts, error } = await db
    .from('service_contracts')
    .select('provider_agent_id, fulfilled_at')
    .not('fulfilled_at', 'is', null);

  if (error) {
    console.error(`⚠️  NOT_CHECKED — could not read service_contracts: ${error.message}`);
    return 2;
  }

  const { data: agentRows, error: agentErr } = await db
    .from('repid_agents')
    .select('id, agent_name');

  if (agentErr) {
    console.error(`⚠️  NOT_CHECKED — could not read repid_agents: ${agentErr.message}`);
    return 2;
  }

  const nameById = new Map<string, string>();
  for (const a of agentRows ?? []) nameById.set(a.id, a.agent_name ?? a.id);

  const byProvider = new Map<string, ProviderStat>();
  for (const c of contracts ?? []) {
    const name = nameById.get(c.provider_agent_id);
    if (!name) continue;
    const cur = byProvider.get(name) ?? { agent_name: name, fulfilled: 0, last_fulfilled: null };
    cur.fulfilled += 1;
    if (!cur.last_fulfilled || c.fulfilled_at > cur.last_fulfilled) cur.last_fulfilled = c.fulfilled_at;
    byProvider.set(name, cur);
  }

  const cutoff = Date.now() - stale * 86_400_000;
  const never: string[] = [];
  const stalled: ProviderStat[] = [];
  const live: ProviderStat[] = [];

  for (const name of agents) {
    const s = byProvider.get(name);
    if (!s || s.fulfilled === 0) {
      never.push(name);
      continue;
    }
    const last = s.last_fulfilled ? new Date(s.last_fulfilled).getTime() : 0;
    (last >= cutoff ? live : stalled).push(s);
  }

  for (const s of [...live, ...stalled]) {
    console.log(`   ✓ ${s.agent_name}: ${s.fulfilled} fulfilled, last ${s.last_fulfilled}`);
  }

  // ALWAYS report the top unenrolled providers, not only on failure. If the
  // enrolled set is the wrong one, that is visible here at a glance and nowhere
  // else — and a reader who only sees it on failure never learns the allowlist
  // is second-best.
  const topUnenrolled = [...byProvider.values()]
    .sort((a, b) => b.fulfilled - a.fulfilled)
    .filter((s) => !agents.has(s.agent_name))
    .slice(0, 5);
  if (topUnenrolled.length > 0) {
    console.log('   providers delivering on this path that are NOT enrolled:');
    for (const s of topUnenrolled) {
      console.log(`   - ${s.agent_name}: ${s.fulfilled} fulfilled, last ${s.last_fulfilled}`);
    }
  }

  if (never.length > 0 || stalled.length > 0) {
    // WHY STALE IS A FAILURE AND NOT A WARNING. The first draft of this script
    // failed only on `fulfilled === 0`, and it would NOT have caught the defect it
    // was written for: the wrongly-enrolled agent had ONE fulfilment, two months
    // stale, so it landed in `stalled`, the other enrolled agent was live, and the
    // script returned VERIFIED over a hook that could never fire on the path that
    // was actually busy. Caught by running the real query, not by reading the code.
    //
    // This allowlist is short and hand-picked. A name in it that has not delivered
    // inside the window is either the wrong name or a path that has gone quiet —
    // both are for a human, and neither is a pass.
    if (never.length > 0) {
      console.error(
        `❌ FAILED — ${never.length} enrolled agent(s) have NEVER fulfilled a service ` +
          'contract as the provider, so the hook can never evaluate them: ' +
          never.join(', '),
      );
    }
    for (const s of stalled) {
      console.error(
        `❌ FAILED — enrolled agent \`${s.agent_name}\` last delivered ${s.last_fulfilled} ` +
          `(> ${stale} days). ${s.fulfilled} fulfilment(s) ever. A hand-picked allowlist ` +
          'entry that has gone quiet is either the wrong name or a dead path.',
      );
    }
    console.error(
      '   Changing the allowlist decides whose reputation a HAL verdict can move. ' +
        'This script will not do it for you.',
    );
    return 1;
  }

  console.log(
    `✅ VERIFIED — all ${agents.size} enrolled agent(s) delivered within ${stale} ` +
      'day(s). The hook can fire.',
  );
  if (mode === 'off') {
    console.log(
      '   NOTE: mode is `off`, so it will not fire until SERVICE_QUALITY_HOOK_MODE is ' +
        'set. That is a separate question from whether it CAN — which is what this ' +
        'script answers, and the one that was silently false.',
    );
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('⚠️  NOT_CHECKED — unexpected error', e);
    process.exit(2);
  });
