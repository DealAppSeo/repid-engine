/**
 * verify:vesting — is any earned RepID stranded past its own vesting cliff?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES [FOUND 2026-09-03, and it had been true for months]
 * ════════════════════════════════════════════════════════════════════════════════
 * A new agent's first rewards do not raise `current_repid`. During a vesting cliff
 * the score route routes them to `vested_repid` instead — deliberate anti-Sybil
 * behaviour that makes a fresh identity expensive to farm.
 *
 * NOTHING RELEASES THE BALANCE WHEN THE CLIFF ENDS. No code path and no database
 * function mentions `vested_repid` except the writer that accumulates into it and
 * the reads that report it. Agents whose cliff expired MONTHS ago still hold their
 * full balance, and some sit at exactly the starting RepID with real earnings
 * beside them. The cliff is a one-way valve.
 *
 * That went unnoticed because a stranded balance is silent from every direction:
 * the score is a plausible number, the agent row looks healthy, and no query
 * anybody runs joins the balance to the date. This script is that query.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IT REPORTS. IT DOES NOT CREDIT.
 * ════════════════════════════════════════════════════════════════════════════════
 * Crediting the stranded balance moves real scores, retroactively, in an
 * append-only ledger that other systems treat as evidence and that agents have
 * already been ranked and attested against. That is a decision with an owner, not
 * a cleanup — the same call CLAUDE.md gives the ecosystem-need multiplier. This
 * script writes nothing.
 *
 * Exit codes follow the repo's three-outcome convention:
 *   0  MEASURED, clean — no balance is past its cliff
 *   1  FAILED — at least one balance is stranded (or older than the grace window)
 *   2  NOT_CHECKED — could not reach the database. Never a silent pass.
 *
 * Usage:
 *   npx ts-node scripts/verify/vesting-not-stranded.ts
 *   npx ts-node scripts/verify/vesting-not-stranded.ts -- --grace-hours 24
 */
import { deriveVestingState } from '../../src/services/vesting-status';

/**
 * `src/db` builds a Supabase client at module scope and `src/config.ts` THROWS when the
 * credentials are absent. A top-level import would therefore make a missing credential
 * exit as an uncaught error — indistinguishable from FAILED, which is precisely the
 * collapse this script's three exit codes exist to prevent. Loading it inside the guard
 * keeps "we could not look" reportable as NOT_CHECKED.
 */
async function loadDb(): Promise<{ db: any } | { err: string }> {
  try {
    // `require`, not dynamic `import()`. BOTH `src/db.ts` AND a `src/db/` directory exist;
    // TypeScript's static resolver picks the file, but `import()` at runtime resolves the
    // DIRECTORY and throws. The first draft of this guard did exactly that and reported
    // NOT_CHECKED unconditionally — a monitoring script that never monitors, which is the
    // failure this file was written to catch, reproduced inside the catcher. Caught by
    // running it, not by reading it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { db: require('../../src/db').db };
  } catch (e: any) {
    return { err: e?.message ?? String(e) };
  }
}

/** How long after a cliff a balance may sit before it counts as stranded. */
function graceHours(): number {
  const i = process.argv.indexOf('--grace-hours');
  const fromArgv = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  const fromEnv = Number(process.env['VESTING_GRACE_HOURS']);
  const v = Number.isFinite(fromArgv) ? fromArgv : Number.isFinite(fromEnv) ? fromEnv : 24;
  return Math.max(0, v);
}

async function main(): Promise<number> {
  const grace = graceHours();
  const now = Date.now();

  const loaded = await loadDb();
  if ('err' in loaded) {
    console.error(
      `⚠️  NOT_CHECKED — no database client (${loaded.err}). Export SUPABASE_URL and a ` +
        'service key to run this against real data.',
    );
    return 2;
  }
  const db = loaded.db;

  const { data, error } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, vested_repid, vesting_cliff_ends_at')
    .gt('vested_repid', 0);

  if (error) {
    // NOT_CHECKED, said out loud. A monitoring script that cannot reach its subject and
    // exits 0 is the defect this whole family of checks exists to remove.
    console.error(`⚠️  NOT_CHECKED — could not read agents: ${error.message}`);
    return 2;
  }

  const rows = data ?? [];
  const stranded = rows.filter((r: any) => {
    if (deriveVestingState(r, now) !== 'MATURED') return false;
    const cliff = new Date(r.vesting_cliff_ends_at).getTime();
    return now - cliff > grace * 3_600_000;
  });
  const undated = rows.filter((r: any) => deriveVestingState(r, now) === 'HELD');
  const vesting = rows.filter((r: any) => deriveVestingState(r, now) === 'VESTING');

  console.log(
    `vesting: ${rows.length} agent(s) hold a balance — ` +
      `${vesting.length} still vesting, ${stranded.length} past cliff + ${grace}h grace, ` +
      `${undated.length} with no cliff date`,
  );

  if (undated.length > 0) {
    // Reported, but not a failure on its own: an undated balance may predate the column.
    console.warn(
      `⚠️  ${undated.length} agent(s) hold a balance with NO cliff date — we cannot say ` +
        `whether those release. Not counted as stranded; not claimed as healthy either.`,
    );
  }

  if (stranded.length === 0) {
    console.log('✅ MEASURED — no vested balance is past its cliff.');
    return 0;
  }

  const total = stranded.reduce((a: number, r: any) => a + Number(r.vested_repid ?? 0), 0);
  console.error(
    `❌ FAILED — ${stranded.length} agent(s) hold ${total} RepID that vested and was ` +
      `never credited. The oldest cliff ended ${Math.floor(
        (now - Math.min(...stranded.map((r: any) => new Date(r.vesting_cliff_ends_at).getTime()))) /
          86_400_000,
      )} day(s) ago.`,
  );
  console.error(
    '   The passport now reports these as vesting state MATURED rather than hiding them ' +
      '(src/services/vesting-status.ts). Crediting the balance moves real scores and is a ' +
      'decision for the owner, not something this script or its caller should do.',
  );
  for (const r of stranded.slice(0, 10)) {
    console.error(`   - ${r.agent_name ?? r.id}: ${r.vested_repid} held, cliff ${r.vesting_cliff_ends_at}`);
  }
  if (stranded.length > 10) console.error(`   … and ${stranded.length - 10} more`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('⚠️  NOT_CHECKED — unexpected error', e);
    process.exit(2);
  });
