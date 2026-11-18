// Planted-defect measurement of the review chain's reviewers (2026-11-17). Uses the SAME runReviewer as the loop: what is measured is what is deployed.
//   node eval.mjs run <reviewerId> [reps=2] [concurrency=2] [gapMs=0] [onlyCaseSubstring]   appends rows to results/<id>.jsonl (resumable)
//   node eval.mjs summary [outFile]                                                         the table, with corpus and grader hashes
// A row the provider never answered (402, 429, timeout, 5xx, no key) is NOT_CHECKED and is in no denominator; a reply that came back but was
// unusable (not JSON, cut off, a quote not in the file, wrong commit) counts against the reviewer: it is the reviewer's own quality.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildCorpus, hashCorpus } from "./corpus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)), RES = path.join(HERE, "results");
const CH = await import("../review-chain.mjs");
const GRADER = "E:/dev/living-docs/_incoming/A2A-2026-11-10/tools/grok-review.v5.mjs";
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 16);
const fileOf = (id) => path.join(RES, `${id.replace(/[^\w.-]/g, "_")}.jsonl`);
const PROVIDER = new Set(["credit", "auth", "quota_day", "rate_limited", "timeout", "server", "model_gone", "network", "no_key", "redirect_host", "paused", "http_other", "fence_open"]);
const wilson = (k, n) => { if (!n) return "n/a"; const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return `${Math.round(100 * (c - h) / d)}-${Math.round(100 * (c + h) / d)}%`; };

function score(c, out) {
  const row = { case: c.id, planted: c.planted, kind: c.kind, ok: Boolean(out.ok), cls: out.ok ? "answered" : out.cls, reason: out.ok ? "" : String(out.reason).slice(0, 160), verdict: out.ok ? out.ev.verdict : "NO_ANSWER", usage: out.usage ?? null, promptChars: out.promptChars };
  const a = out.answer;
  if (a) {
    row.items = Object.fromEntries(Object.entries(a.checklist || {}).map(([k, v]) => [k, v?.status]));
    row.findings = (a.findings || []).length;
    const flat = (s) => String(s ?? "").replace(/\s+/g, " ");
    const quotes = [...Object.values(a.checklist || {}).filter((v) => v?.status === "PROBLEM").flatMap((v) => (v.evidence || []).map((e) => e.quote)), ...(a.findings || []).map((f) => f.quote)].map(flat);
    if (c.planted && out.ev.verdict === "CHANGES_REQUESTED") {
      const e = c.expect;
      row.hit_strict = Boolean((e.item && a.checklist?.[e.item]?.status === "PROBLEM") || (e.hint && quotes.some((q) => q.includes(flat(e.hint)))));
    }
  }
  return row;
}

async function run(id, reps, conc, gap, only) {
  const r = CH.ALL.find((x) => x.id === id);
  if (!r) throw new Error(`unknown reviewer ${id}`);
  fs.mkdirSync(RES, { recursive: true });
  fs.mkdirSync(path.join(HERE, "logs"), { recursive: true });
  fs.writeFileSync(path.join(HERE, "logs", `${id.replace(/[^\w.-]/g, "_")}.pid`), String(process.pid)); // so a stop kills this run's tree and nothing else
  const f = fileOf(id), done = new Set(fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((x) => `${x.case}#${x.rep}`) : []);
  const jobs = [];
  for (let rep = 1; rep <= reps; rep++) for (const c of buildCorpus()) if ((!only || c.id.includes(only)) && !done.has(`${c.id}#${rep}`)) jobs.push({ c, rep });
  console.log(`${id}: ${jobs.length} runs to do (${done.size} already done)`);
  let next = 0, lastStart = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { c, rep } = jobs[next++];
      const wait = lastStart + gap - Date.now(); lastStart = Math.max(Date.now(), lastStart + gap);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-"));
      CH.writeStage(dir, c.files);
      const t0 = Date.now();
      const out = await CH.runReviewer(r, { dir, files: c.files, sha: c.sha, nonce: c.nonce });
      fs.rmSync(dir, { recursive: true, force: true });
      const row = { at: new Date().toISOString(), reviewer: id, model: r.cand?.model ?? r.label, family: r.family, rep, ms: Date.now() - t0, ...score(c, out) };
      fs.appendFileSync(f, JSON.stringify(row) + "\n");
      console.log(`${id} ${c.id}#${rep}: ${row.verdict}${row.ok ? "" : ` (${row.cls}: ${row.reason.slice(0, 80)})`}${row.hit_strict !== undefined ? ` strict=${row.hit_strict}` : ""} ${row.ms}ms`);
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
}

function summary(outFile) {
  const cs = buildCorpus(), hash = hashCorpus(cs), files = fs.existsSync(RES) ? fs.readdirSync(RES).filter((n) => n.endsWith(".jsonl")) : [];
  const L = [`Ruler: corpus ${hash} (${cs.length} cases: ${cs.filter((c) => c.planted).length} planted, ${cs.filter((c) => !c.planted).length} clean; real \`node --test\` output, node ${process.version}); grader grok-review.v5 judge ${sha(GRADER)}; review-chain ${sha(path.join(HERE, "../review-chain.mjs"))}; harness ${sha(fileURLToPath(import.meta.url))}.`, "",
    "| reviewer (family) | runs | usable | planted: caught (CR) | planted: right item/line | planted: PASSed (worst miss) | clean: false alarm | clean: PASS | provider failures (not counted) | bad replies | median s |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  const data = [];
  for (const n of files) {
    const rows = fs.readFileSync(path.join(RES, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (!rows.length) continue;
    const prov = rows.filter((r) => PROVIDER.has(r.cls)), judged = rows.filter((r) => !PROVIDER.has(r.cls)), bad = judged.filter((r) => !r.ok), ok = judged.filter((r) => r.ok);
    const P = ok.filter((r) => r.planted), C = ok.filter((r) => !r.planted), cr = P.filter((r) => r.verdict === "CHANGES_REQUESTED"), strict = P.filter((r) => r.hit_strict);
    const missed_pass = P.filter((r) => r.verdict === "PASS"), fa = C.filter((r) => r.verdict === "CHANGES_REQUESTED"), pass = C.filter((r) => r.verdict === "PASS");
    const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0);
    const d = { reviewer: rows[0].reviewer, model: rows[0].model, family: rows[0].family, runs: rows.length, provider_failures: prov.length, bad: bad.length, usable: ok.length, judged: judged.length,
      planted_answered: P.length, planted_pass: missed_pass.length, caught: cr.length, strict: strict.length, clean_answered: C.length, false_alarm: fa.length, clean_pass: pass.length, median_ms: med(rows.map((r) => r.ms)),
      failure_classes: Object.fromEntries([...new Set(rows.filter((r) => !r.ok).map((r) => r.cls))].map((k) => [k, rows.filter((r) => r.cls === k).length])) };
    data.push(d);
    L.push(`| \`${d.reviewer}\` (${d.family}) | ${d.runs} | ${d.usable}/${d.judged} (${wilson(d.usable, d.judged)}) | ${d.caught}/${d.planted_answered} (${wilson(d.caught, d.planted_answered)}) | ${d.strict}/${d.planted_answered} (${wilson(d.strict, d.planted_answered)}) | ${d.planted_pass}/${d.planted_answered} | ${d.false_alarm}/${d.clean_answered} (${wilson(d.false_alarm, d.clean_answered)}) | ${d.clean_pass}/${d.clean_answered} (${wilson(d.clean_pass, d.clean_answered)}) | ${d.provider_failures}${d.provider_failures ? ` (${Object.entries(d.failure_classes).filter(([k]) => PROVIDER.has(k)).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""} | ${d.bad}${d.bad ? ` (${Object.entries(d.failure_classes).filter(([k]) => !PROVIDER.has(k)).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""} | ${(d.median_ms / 1000).toFixed(1)} |`);
    data.at(-1).by_kind = Object.fromEntries([...new Set(P.map((r) => r.kind))].sort().map((k) => [k, [P.filter((r) => r.kind === k && r.hit_strict).length, P.filter((r) => r.kind === k).length]]));
  }
  const kinds = [...new Set(data.flatMap((d) => Object.keys(d.by_kind || {})))].sort();
  L.push("", "Planted defects by kind: caught with the right item or line / usable runs on that kind", "", `| reviewer | ${kinds.join(" | ")} |`, `|---|${kinds.map(() => "---").join("|")}|`, ...data.map((d) => `| \`${d.reviewer}\` | ${kinds.map((k) => (d.by_kind?.[k] ? `${d.by_kind[k][0]}/${d.by_kind[k][1]}` : "-")).join(" | ")} |`));
  L.push("", "usable = a reply that parsed, named this commit, and passed every quote check; denominators exclude provider failures. 95% Wilson intervals; fewer than 30 judged runs per cell is NOISE, so no order is claimed where intervals overlap.");
  const text = L.join("\n") + "\n";
  console.log(text);
  if (outFile) { fs.writeFileSync(outFile, text); fs.writeFileSync(outFile.replace(/\.md$/, ".json"), JSON.stringify({ corpus: hash, node: process.version, grader: sha(GRADER), data }, null, 2) + "\n"); }
}

const [mode, a, b, c, d, e] = process.argv.slice(2);
if (mode === "run") await run(a, Number(b ?? 2), Number(c ?? 2), Number(d ?? 0), e);
else if (mode === "summary") summary(a);
else console.log("usage: node eval.mjs run <reviewerId> [reps] [concurrency] [gapMs] [only] | summary [outFile]");
