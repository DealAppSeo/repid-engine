/**
 * trust-loop-e2e.ts  —  strict, READ-ONLY trust-loop receipt.
 *
 * Answers "is the moat actually live right now?" in one command, with FACTUAL
 * data pulled from Supabase + the ledger. It does NOT mutate anything and does
 * NOT spend — the action scripts (run-hal-validation, drive-settlements-loop,
 * couple-settlement-repid, produce-first-onchain-write) do that. This script
 * only PROVES state and prints a pass/fail receipt with real tx hashes.
 *
 * Verdicts are strict and fail LOUD — a stale/degraded rung is WARN/FAIL, never
 * a silent green (the opposite of the lenient E2E suite that soft-skips on 401).
 *
 * Run:
 *   DOTENV_CONFIG_PATH=C:/Users/Cash4/repos/.env.master \
 *   npx ts-node -r dotenv/config scripts/smoke/trust-loop-e2e.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}
const supa = createClient(url, key, { auth: { persistSession: false } });

type Verdict = "PASS" | "WARN" | "FAIL";
const rungs: { id: string; name: string; verdict: Verdict; detail: string }[] = [];
function record(id: string, name: string, verdict: Verdict, detail: string) {
  rungs.push({ id, name, verdict, detail });
}
function ageHours(ts: string | null): number {
  if (!ts) return Infinity;
  return (Date.now() - Date.parse(ts)) / 3_600_000;
}
function fmtAge(ts: string | null): string {
  const h = ageHours(ts);
  if (!isFinite(h)) return "never";
  if (h < 1) return `${Math.round(h * 60)}m ago`;
  if (h < 48) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

async function rung0_halAccuracy() {
  // latest validation run → F1 + provider diversity + staleness
  const { data: latest } = await supa
    .from("hal_validation_runs")
    .select("run_id, run_at")
    .order("run_at", { ascending: false })
    .limit(1);
  if (!latest || latest.length === 0) {
    return record("R0", "HAL accuracy (F1)", "FAIL", "no hal_validation_runs rows at all");
  }
  const runId = latest[0]!.run_id as string;
  const runAt = latest[0]!.run_at as string;
  // Use the harness-stored `correct` flag (join-free — works for both DB-backed and
  // file-backed corpora). vetoed = predicted-positive; clean/flagged = predicted-negative.
  const { data: rows } = await supa
    .from("hal_validation_runs")
    .select("hal_decision, correct, provider")
    .eq("run_id", runId);
  if (!rows || rows.length === 0) {
    return record("R0", "HAL accuracy (F1)", "FAIL", `latest run ${runId} has no rows`);
  }
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    const dec = String(r.hal_decision);
    const decVeto = dec === "vetoed" || dec === "veto";
    const correct = r.correct === true;
    if (decVeto && correct) tp++;
    else if (decVeto && !correct) fp++;
    else if (!decVeto && correct) tn++;
    else fn++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  const providers = new Set(rows.map((r) => r.provider).filter(Boolean));
  const multiModel = providers.size >= 2;
  const stale = ageHours(runAt) > 7 * 24;
  const detail = `F1=${f1.toFixed(4)} (P=${prec.toFixed(3)} R=${rec.toFixed(3)}, n=${rows.length}) · providers={${[...providers].join(",") || "none"}} · run ${fmtAge(runAt)}`;
  let v: Verdict = "PASS";
  if (f1 < 0.7 || !multiModel) v = "WARN";
  if (stale) v = "WARN";
  if (f1 < 0.5) v = "FAIL";
  record("R0", "HAL accuracy (F1)", v, detail + (stale ? " ⚠STALE(>7d)" : "") + (!multiModel ? " ⚠single-provider" : ""));
}

async function rung1_halLiveMode() {
  const { data } = await supa
    .from("repid_score_events")
    .select("llm_provider, created_at")
    .eq("event_type", "HAL_SCORE_EVENT")
    .order("created_at", { ascending: false })
    .limit(200);
  if (!data || data.length === 0) {
    return record("R1", "HAL live scoring", "FAIL", "no HAL_SCORE_EVENT rows");
  }
  const providers = new Set(data.map((r) => r.llm_provider).filter(Boolean));
  const latest = data[0]!.created_at as string;
  const multi = providers.size >= 2;
  record(
    "R1",
    "HAL live scoring",
    multi ? "PASS" : "WARN",
    `${data.length} recent events, latest ${fmtAge(latest)} · distinct providers={${[...providers].join(",") || "none/deterministic"}}` +
      (multi ? "" : " ⚠not multi-model (extractor/single)"),
  );
}

async function rung2_x402Real() {
  const { data } = await supa
    .from("x402_settlements")
    .select("tx_hash, is_simulated, status, amount, asset, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    return record("R2", "x402 real settlement", "FAIL", "no x402_settlements rows");
  }
  const s = data[0]!;
  const real = s.is_simulated === false && !!s.tx_hash;
  record(
    "R2",
    "x402 real settlement",
    real ? "PASS" : "WARN",
    `is_simulated=${s.is_simulated} status=${s.status} amount=${s.amount} ${s.asset} · ${fmtAge(s.created_at as string)}\n        tx=${s.tx_hash ?? "(none)"}`,
  );
}

async function rung3_repidCoupling() {
  const { data } = await supa
    .from("repid_score_events")
    .select("agent_id, delta, repid_before, repid_after, created_at, contract_id")
    .eq("event_type", "SERVICE_FULFILLED")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    return record("R3", "settlement → RepID", "FAIL", "no SERVICE_FULFILLED events");
  }
  const e = data[0]!;
  const moved = Number(e.delta) !== 0 && e.repid_before !== e.repid_after;
  record(
    "R3",
    "settlement → RepID",
    moved ? "PASS" : "WARN",
    `delta=${e.delta} ${e.repid_before}→${e.repid_after} · ${fmtAge(e.created_at as string)}`,
  );
}

async function rung4_erc8004() {
  const { data } = await supa
    .from("erc8004_reputation_writes")
    .select("agent_id, repid_value, tier, tx_hash, block_number, created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || data.length === 0) {
    return record("R4", "ERC-8004 on-chain write", "FAIL", "no erc8004_reputation_writes rows");
  }
  const w = data[0]!;
  const stale = ageHours(w.created_at as string) > 14 * 24;
  record(
    "R4",
    "ERC-8004 on-chain write",
    stale ? "WARN" : "PASS",
    `agent=${w.agent_id} repid=${w.repid_value} tier=${w.tier} block=${w.block_number} · ${fmtAge(w.created_at as string)}${stale ? " ⚠dormant(>14d)" : ""}\n        tx=${w.tx_hash}`,
  );
}

async function rung5_autoLoop() {
  // Is a worker auto-coupling? Compare newest settlement vs newest auto-driven downstream event.
  const [{ data: settle }, { data: fulfilled }, { data: erc }] = await Promise.all([
    supa.from("x402_settlements").select("created_at").order("created_at", { ascending: false }).limit(1),
    supa.from("repid_score_events").select("created_at").eq("event_type", "SERVICE_FULFILLED").order("created_at", { ascending: false }).limit(1),
    supa.from("erc8004_reputation_writes").select("created_at").order("created_at", { ascending: false }).limit(1),
  ]);
  const sTs = settle?.[0]?.created_at as string | undefined;
  const fTs = fulfilled?.[0]?.created_at as string | undefined;
  const eTs = erc?.[0]?.created_at as string | undefined;
  if (!sTs) return record("R5", "auto-loop (workers)", "FAIL", "no settlements to key off");
  // if downstream events are OLDER than the latest settlement, the worker isn't consuming
  const fLag = fTs ? (Date.parse(sTs) - Date.parse(fTs)) / 3_600_000 : Infinity;
  const eLag = eTs ? (Date.parse(sTs) - Date.parse(eTs)) / 3_600_000 : Infinity;
  const consuming = fLag < 1 && eLag < 24; // downstream within 1h/24h of newest settlement
  record(
    "R5",
    "auto-loop (workers)",
    consuming ? "PASS" : "WARN",
    consuming
      ? "downstream events track latest settlement — workers consuming"
      : `manual-only: newest settlement ${fmtAge(sTs)}, but newest SERVICE_FULFILLED ${fmtAge(fTs ?? null)} & ERC-8004 ${fmtAge(eTs ?? null)} → FeedbackLoopWorker not auto-consuming (ENGINE_WORKERS_ENABLED off?)`,
  );
}

async function main() {
  const started = new Date().toISOString();
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  TRUST-LOOP E2E RECEIPT  ·  ${started}  ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
  await rung0_halAccuracy();
  await rung1_halLiveMode();
  await rung2_x402Real();
  await rung3_repidCoupling();
  await rung4_erc8004();
  await rung5_autoLoop();

  const icon = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌" };
  for (const r of rungs) {
    console.log(`${icon[r.verdict]} ${r.id}  ${r.name}`);
    console.log(`        ${r.detail}\n`);
  }
  const pass = rungs.filter((r) => r.verdict === "PASS").length;
  const warn = rungs.filter((r) => r.verdict === "WARN").length;
  const fail = rungs.filter((r) => r.verdict === "FAIL").length;
  console.log(`──────────────────────────────────────────────────────────────────`);
  console.log(`VERDICT: ${pass} PASS · ${warn} WARN · ${fail} FAIL   (${rungs.length} rungs)`);
  console.log(`──────────────────────────────────────────────────────────────────\n`);
  process.exit(fail > 0 ? 2 : warn > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
