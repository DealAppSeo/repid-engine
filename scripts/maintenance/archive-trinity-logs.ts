/**
 * archive-trinity-logs.ts
 *
 * READ-ONLY. Walks trinity_agent_logs by primary key (id, indexed) so no query
 * ever seq-scans (a filter on `action` seq-scans and times out under load).
 * Classifies each row into:
 *   - NOISE  (operational churn: llm_failover, api_auth_attempt, task lifecycle …)
 *   - SIGNAL (everything else — HAL/substance-gate, bft_slash, sbfa_pi_terms,
 *             calibration_audit, timl_routing_decision, escalations, help_request …)
 * Archives ALL rows (full columns) to compressed JSONL on the E: drive, split
 * signal/noise, so nothing is lost before the prune. DuckDB-queryable later.
 *
 * Does NOT delete anything. The prune is a separate, explicitly-gated script.
 *
 * Run:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   npx ts-node scripts/maintenance/archive-trinity-logs.ts
 * (or via DOTENV_CONFIG_PATH=.env.master -r dotenv/config)
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}
const supa = createClient(url, key, { auth: { persistSession: false } });

const NOISE = new Set([
  "llm_failover",
  "api_auth_attempt",
  "task_processing",
  "task_reaped",
  "task_processing_llm",
  "llm_error",
  "learning_triggered",
  "task_failure",
  "task_processing_local",
  "success_criteria_skipped",
  "task_processing_contract",
]);

const CUTOFF_DAYS = 14;
const cutoffMs = Date.now() - CUTOFF_DAYS * 24 * 3600 * 1000;
const cutoffIso = new Date(cutoffMs).toISOString();

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const ARCHIVE_DIR = path.win32.join("E:\\", "dev", "archives", "trinity_agent_logs");
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

const signalPath = path.join(ARCHIVE_DIR, `signal-${stamp}.jsonl.gz`);
const noiseOldPath = path.join(ARCHIVE_DIR, `noise-older-${CUTOFF_DAYS}d-${stamp}.jsonl.gz`);
const signalGz = zlib.createGzip();
const noiseGz = zlib.createGzip();
signalGz.pipe(fs.createWriteStream(signalPath));
noiseGz.pipe(fs.createWriteStream(noiseOldPath));

function writeRow(gz: zlib.Gzip, row: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    gz.write(JSON.stringify(row) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}
function endGz(gz: zlib.Gzip): Promise<void> {
  return new Promise((resolve) => gz.end(resolve));
}

async function main() {
  console.log(`Archive dir: ${ARCHIVE_DIR}`);
  console.log(`Cutoff (${CUTOFF_DAYS}d): ${cutoffIso}`);

  let cursor = "00000000-0000-0000-0000-000000000000";
  const PAGE = 2000;
  let scanned = 0;
  let signal = 0;
  let noiseOld = 0;
  let noiseRecent = 0;
  const byAction: Record<string, number> = {};
  const t0 = Date.now();

  for (;;) {
    const { data, error } = await supa
      .from("trinity_agent_logs")
      .select("*")
      .gt("id", cursor)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (error) throw new Error(`page fetch failed at cursor ${cursor}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as Array<Record<string, unknown>>) {
      scanned++;
      const action = String(row.action ?? "");
      const isNoise = NOISE.has(action);
      const createdMs = row.created_at ? Date.parse(String(row.created_at)) : Date.now();
      if (!isNoise) {
        await writeRow(signalGz, row);
        signal++;
        byAction[action] = (byAction[action] ?? 0) + 1;
      } else if (createdMs < cutoffMs) {
        await writeRow(noiseGz, row);
        noiseOld++;
      } else {
        noiseRecent++;
      }
    }
    cursor = String((data[data.length - 1] as Record<string, unknown>).id);
    if (scanned % 50000 < PAGE) {
      const rate = Math.round(scanned / ((Date.now() - t0) / 1000));
      console.log(`  scanned ${scanned}  signal ${signal}  noiseOld ${noiseOld}  noiseRecent ${noiseRecent}  (${rate}/s)`);
    }
  }

  await endGz(signalGz);
  await endGz(noiseGz);

  const summary = {
    finished_at: new Date().toISOString(),
    cutoff_days: CUTOFF_DAYS,
    cutoff_iso: cutoffIso,
    scanned,
    signal_rows_archived: signal,
    noise_old_rows_archived: noiseOld,
    noise_recent_kept_in_db: noiseRecent,
    delete_target_noise_old: noiseOld,
    signal_by_action: byAction,
    signal_file: signalPath,
    noise_old_file: noiseOldPath,
  };
  fs.writeFileSync(path.join(ARCHIVE_DIR, `manifest-${stamp}.json`), JSON.stringify(summary, null, 2));
  console.log("\n=== ARCHIVE COMPLETE ===");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
