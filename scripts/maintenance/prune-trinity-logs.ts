/**
 * prune-trinity-logs.ts
 *
 * DESTRUCTIVE. Deletes ONLY noise action-types older than 14 days, in
 * server-side batches via the prune_trinity_logs_batch() function (index-driven,
 * each batch well under the statement timeout). Signal rows and recent noise are
 * never touched.
 *
 * GATED: does nothing unless APPLY=1 is set. Without APPLY it just reports the
 * batch function is reachable and exits.
 *
 * Run the real prune:
 *   APPLY=1 SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   npx ts-node scripts/maintenance/prune-trinity-logs.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}
const supa = createClient(url, key, { auth: { persistSession: false } });

const CUTOFF_DAYS = 14;
const cutoffIso = new Date(Date.now() - CUTOFF_DAYS * 24 * 3600 * 1000).toISOString();
const APPLY = process.env.APPLY === "1";

async function pruneBatch(limit: number): Promise<number> {
  const { data, error } = await supa.rpc("prune_trinity_logs_batch", {
    p_cutoff: cutoffIso,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

async function main() {
  console.log(`Cutoff (${CUTOFF_DAYS}d): ${cutoffIso}`);
  if (!APPLY) {
    console.log("DRY RUN (APPLY not set). Not deleting. Set APPLY=1 to prune.");
    return;
  }
  let batch = 10000;
  let total = 0;
  let rounds = 0;
  const t0 = Date.now();
  for (;;) {
    let n: number;
    try {
      n = await pruneBatch(batch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout|57014/i.test(msg) && batch > 500) {
        batch = Math.max(500, Math.floor(batch / 2));
        console.log(`  batch timed out, reducing to ${batch}`);
        continue;
      }
      throw e;
    }
    total += n;
    rounds++;
    if (n > 0) {
      const rate = Math.round(total / ((Date.now() - t0) / 1000));
      console.log(`  round ${rounds}: deleted ${n} (total ${total}, ~${rate}/s, batch ${batch})`);
    }
    if (n === 0) break;
  }
  console.log(`\n=== PRUNE COMPLETE === deleted ${total} rows in ${rounds} rounds.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
