/**
 * run-decay-sweep.ts — the caller for `src/scoring/decay-sweep.ts`.
 *
 * `npm run decay:sweep`            observe and write
 * `npm run decay:sweep -- --dry`   observe and print, write nothing
 *
 * WHY THIS FILE EXISTS SEPARATELY. A sweep with no scheduled caller is a mechanism
 * wired at one end — it would sit in the tree looking like coverage while observing
 * nobody, which is the failure the sweep was written to fix. This is the end that
 * makes it real, and the thing a Railway cron points at.
 *
 * It exits NON-ZERO when the sweep observes nobody. A cron entry that reports
 * success while measuring an empty roster is worse than no cron entry: it converts
 * "we have no data" into "we looked and there was nothing", and those are not the
 * same sentence.
 */
import { runDecaySweep } from '../../src/scoring/decay-sweep';

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');

  const r = await runDecaySweep({ persist: !dry });

  // Distribution first — it is the reason the sweep exists. The ratchet decision
  // rests on the zero-activity line, so it is reported even when it is 0.
  console.log(
    [
      `[decay-sweep] sweep_id=${r.sweep_id}${dry ? ' (DRY RUN — nothing written)' : ''}`,
      `  observed            ${r.observed}`,
      `  zero-activity       ${r.zero_activity}`,
      `  would bite          ${r.would_bite}`,
      `  points at risk      ${r.total_points_at_risk}`,
      `  largest single drop ${r.max_would_remove}`,
      `  ruler               ${r.params_ruler ?? 'NONE — set SCORING_RULER_SALT to make sweeps comparable across a re-tune'}`,
      `  rows written        ${dry ? 0 : r.written}`,
    ].join('\n'),
  );

  if (r.observed === 0) {
    console.error(
      '[decay-sweep] observed 0 agents — failing loudly rather than reporting an empty sweep as a clean one.',
    );
    process.exit(1);
  }

  if (!dry && r.written !== r.observed) {
    console.error(
      `[decay-sweep] wrote ${r.written} rows for ${r.observed} observations — the store and the ` +
        'measurement disagree; treat this sweep as incomplete.',
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`[decay-sweep] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
