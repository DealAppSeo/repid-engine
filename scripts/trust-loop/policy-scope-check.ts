/**
 * policy-scope-check.ts — the half of the scoring policy that `policy_version`
 * cannot see.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE HOLE, FOUND BY XC ON 2026-08-22
 * ════════════════════════════════════════════════════════════════════════════════
 * `src/services/policy-version.ts` derives `pol1-<digest>` by probing the policy's
 * observed behaviour, precisely so nobody has to remember to bump a string. Its
 * own header explains that the neighbouring hand-bumped version had already
 * failed that way once.
 *
 * It probes `deltaFor` and `assessRisk`. Both are pure application code. **It
 * touches nothing in the database** — and the database is where
 * `trg_repid_earned_floor` decides what an agent actually pays.
 *
 * So the digest is wired at both ends for one half of the policy and wired at
 * neither end for the other. Change the floor's shape tomorrow and
 * `pol1-37804d…` stays byte-identical, every ledger row keeps claiming one
 * regime across the change, and a best-response result gets stamped valid for a
 * policy it was never searched against. That is the exact failure the derived
 * digest was built to prevent, reintroduced through the half nobody probed.
 *
 * XC named it as `[UNVERIFIED]`; it is now verified, and this is the fix.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A CHECK AND NOT AN EXTENSION OF THE DIGEST
 * ════════════════════════════════════════════════════════════════════════════════
 * The obvious repair is to fold the trigger definition into `policyTranscript()`.
 * That would make the digest asynchronous and database-dependent — every caller
 * that wants a `policy_version` would need a live connection, and a scoring path
 * that cannot compute its own policy version without a round trip is worse than
 * the problem.
 *
 * So the digest stays pure and honest about its scope, and the DB half is pinned
 * HERE, as an assertion that runs. When the floor changes, this fails, and the
 * failure is the prompt to bump the scoring policy deliberately. A rule that
 * lives only in a comment is the thing that already failed once.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IS PINNED, AND WHY THESE THREE
 * ════════════════════════════════════════════════════════════════════════════════
 *   trg_repid_earned_floor   — decides what an agent actually pays below its floor
 *   tier_lower_bound         — decides where that floor sits
 *   apply_repid_score_event  — decides what the ledger records as having happened
 *
 * Between them they determine the delta an agent really experiences. The pure
 * digest determines the delta the policy intended. Both halves have to be
 * version-bound or a replay compares two different things.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   npx ts-node scripts/trust-loop/policy-scope-check.ts
 *
 * Exit codes:
 *   0  VERIFIED     — the DB half matches what the pins describe
 *   1  FAILED       — it changed; bump the scoring policy and re-pin, in one commit
 *   2  NOT_CHECKED  — could not read the definitions
 */
import { createHash } from 'crypto';
import { db } from '../../src/db';
import { currentPolicyVersion } from '../../src/services/policy-version';

/**
 * Pinned 2026-08-22 against the live database.
 *
 * A digest of the function's own source text, so a whitespace-only edit trips it
 * too. That is deliberate: this pin is not trying to detect *meaningful* change,
 * because deciding what counts as meaningful is exactly the judgement that goes
 * wrong. Any change at all forces a human to look.
 */
const PINNED: Readonly<Record<string, string>> = Object.freeze({
  'public.trg_repid_earned_floor()':
    '64f804d27e32d4c6e43c28e9a53ce1db675b6a9c21aa0a765c37133b96d75aa5',
  'public.tier_lower_bound(integer)':
    '60fb4adf69c48962ab33e0ef49edf06150d6a2e59f2e1422862cc08e72600024',
  'public.apply_repid_score_event()':
    '65f6ce0a0feaf67331a601808b4f00b5de87e5475e85b546a497b4ab1ea8fbcf',
});

/** The scoring digest these pins were taken alongside. */
const PINNED_ALONGSIDE_POLICY_VERSION = 'pol1-37620edf769590dd';

async function definitionOf(signature: string): Promise<string | null> {
  const { data, error } = await db.rpc('run_sql', {
    query: `select pg_get_functiondef('${signature}'::regprocedure) as def;`,
  });
  if (error || !data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { def?: string })?.def ?? null;
}

async function main(): Promise<void> {
  const scoring = currentPolicyVersion();
  console.log('policy scope check');
  console.log(`  scoring digest (pure, app-side)   ${scoring}`);
  console.log(`  pinned alongside                  ${PINNED_ALONGSIDE_POLICY_VERSION}`);
  console.log('');

  if (scoring !== PINNED_ALONGSIDE_POLICY_VERSION) {
    // Not a failure of the DB half — but the two halves are now describing
    // different moments, and saying so is the whole point.
    console.log('  NOTE: the scoring digest has moved since these pins were taken.');
    console.log('        Re-pin in the same commit that moved it, so the halves stay paired.');
    console.log('');
  }

  const drifted: string[] = [];
  for (const [signature, expected] of Object.entries(PINNED)) {
    const def = await definitionOf(signature);
    if (def === null) {
      console.error(`NOT_CHECKED — could not read ${signature}`);
      process.exit(2);
    }
    const actual = createHash('sha256').update(def, 'utf8').digest('hex');
    const ok = actual === expected;
    console.log(`  ${ok ? 'ok  ' : 'DRIFT'}  ${signature}`);
    if (!ok) drifted.push(signature);
  }
  console.log('');

  if (drifted.length > 0) {
    console.log('FAILED — the database half of the scoring policy changed.');
    console.log('        `policy_version` did NOT move, because it cannot see these.');
    console.log('        Every row written since claims a regime that no longer holds, and any');
    console.log('        best-response result stamped with the current digest is stale.');
    console.log('');
    console.log('        Bump the scoring policy and re-pin here IN THE SAME COMMIT, so the');
    console.log('        two halves are never separately true.');
    process.exit(1);
  }

  console.log('VERIFIED — the database half matches its pins.');
  console.log('           `policy_version` still describes the whole policy, not half of it.');
  process.exit(0);
}

main().catch((e) => {
  console.error(`NOT_CHECKED — scope check threw: ${e?.message ?? e}`);
  process.exit(2);
});
