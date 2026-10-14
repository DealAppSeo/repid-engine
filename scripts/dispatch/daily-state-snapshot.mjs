#!/usr/bin/env node
/**
 * daily-state-snapshot.mjs — the anti-stale heartbeat. GENERATES a dated state report from LIVE truth
 * (never hand-written, so it can't rot), pushes a Telegram digest, and — most importantly — runs the
 * DEPLOY-DRIFT CANARY across every Railway service: any latest deploy that isn't SUCCESS gets flagged.
 * That single check catches the "green ≠ latest" trap (repid-engine 06-26, zkp-postcard, etc.) on day 1.
 *
 * Run: node daily-state-snapshot.mjs            (writes report + prints digest)
 *      DAILY_TELEGRAM=1 node daily-state-snapshot.mjs   (also pushes the digest to your phone)
 * Schedule ~5AM via Windows Task Scheduler (run-daily-snapshot.bat next to this file). Read-only queries +
 * a report write + a Telegram msg — safe.
 *
 * DB credential: see db-creds.js — SUPABASE_SECRET_KEY (sb_secret_…), else DATABASE_URL. Legacy JWT keys
 * are disabled on prod (that is what broke every run from 2026-10-12). FAILS LOUD: the report is still
 * written with the reason, and the process exits 1 so Task Scheduler's "Last Run Result" is not 0.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCreds, makeRunSql, buildStatus, buildHealth } from './status.mjs';

const M = 'C:/Users/Cash4/repos/.env.master';
const key = (n) => { try { return (readFileSync(M, 'utf8').match(new RegExp('^' + n + "\\s*=\\s*[\"']?([^\"'\\s]+)", 'm')) || [])[1] || null; } catch { return null; } };
const RTK = key('RAILWAY_API_TOKEN');
const railway = async (q, v) => { const r = await fetch('https://backboard.railway.app/graphql/v2', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RTK }, body: JSON.stringify({ query: q, variables: v }) }); return r.json(); };

// Watched Railway projects, by NAME. Ids are looked up with the token at run time, so this public file
// carries no infrastructure ids. A watched project the token cannot see is flagged, never skipped.
const WATCHED = ['repid-engine', 'AITrinitySymphony'];

async function watchedProjects() {
  const j = await railway(`query { projects { edges { node { id name } } } }`);
  if (j.errors || !j.data) throw new Error(`Railway projects query failed: ${JSON.stringify(j.errors?.[0]?.message ?? 'no data')}`);
  const byName = new Map(j.data.projects.edges.map((e) => [e.node.name, e.node.id]));
  return WATCHED.map((name) => [name, byName.get(name) ?? null]);
}

// ---- DEPLOY-DRIFT CANARY: any service whose latest deploy != SUCCESS ----
async function driftCanary() {
  const flags = [], ok = [];
  let projects;
  try { projects = await watchedProjects(); }
  catch (e) { return { flags: [`🔴 drift canary NOT CHECKED: ${e.message}`], okCount: 0 }; }
  for (const [pname, pid] of projects) {
    if (!pid) { flags.push(`🔴 ${pname}: project not visible to RAILWAY_API_TOKEN (NOT CHECKED)`); continue; }
    const j = await railway(`query($id:String!){ project(id:$id){ services{edges{node{ name serviceInstances{edges{node{ latestDeployment{ status createdAt } }}} }}} } }`, { id: pid });
    if (j.errors) { flags.push(`${pname}: API error ${JSON.stringify(j.errors[0]?.message)}`); continue; }
    for (const s of j.data.project.services.edges) {
      const d = s.node.serviceInstances.edges[0]?.node.latestDeployment;
      const st = d?.status;
      if (!st) continue;
      if (st === 'SUCCESS') ok.push(`${s.node.name}`);
      else flags.push(`🔴 ${pname}/${s.node.name}: last deploy ${st} (${(d.createdAt || '').slice(0, 10)})`);
    }
  }
  return { flags, okCount: ok.length };
}

async function main() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const ts = now.toISOString().slice(0, 16).replace('T', ' ') + 'Z';

  const drift = await driftCanary();
  const failures = [];
  let dbBlock = '(DB status unavailable)';
  try { const runSql = await makeRunSql(resolveCreds()); dbBlock = await buildStatus(runSql); const h = await buildHealth(runSql); dbBlock += '\n' + h; try { runSql.close(); } catch {} }
  catch (e) { dbBlock = '⚠ DB status failed: ' + e.message; failures.push('DB status: ' + e.message); }

  const driftBlock = drift.flags.length
    ? `⚠ DEPLOY DRIFT — ${drift.flags.length} service(s) NOT on a clean deploy:\n` + drift.flags.join('\n')
    : `✅ Deploys clean — all ${drift.okCount} services on a SUCCESS build.`;

  const report = [
    `# DAILY STATE — ${date} (generated ${ts}, live truth)`,
    ``, `## 🚦 Deploy-drift canary`, driftBlock,
    ``, `## 📊 Ecosystem`, dbBlock,
    ``, `---`, `*Generated from live Railway API + DB. Never hand-edited — if a fact here is wrong, the source moved; re-query. green ≠ latest.*`,
  ].join('\n');

  const dir = `E:/dev/reports/${date}`;
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `DAILY_STATE_${date}.md`), report, 'utf8'); } catch (e) { console.error('report write failed:', e.message); failures.push('report write: ' + e.message); }

  console.log(report);

  if (process.env.DAILY_TELEGRAM === '1') {
    const digest = [`📅 Daily state ${date}`, drift.flags.length ? driftBlock : `✅ deploys clean (${drift.okCount} svc)`, '', dbBlock.split('\n').slice(0, 6).join('\n')].join('\n');
    const TK = (() => { try { return readFileSync(join(homedir(), '.telegram-bot-token'), 'utf8').trim(); } catch { return null; } })();
    const CH = (() => { try { return readFileSync(join(homedir(), '.telegram-chat-id'), 'utf8').trim(); } catch { return null; } })();
    if (TK && CH) { await fetch(`https://api.telegram.org/bot${TK}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CH, text: digest.slice(0, 3900), disable_web_page_preview: true }) }); console.error('[daily] telegram digest sent'); }
  }
  if (failures.length) {
    console.error('[daily] FAILED — ' + failures.join(' | '));
    process.exitCode = 1;
  }
}
main().catch(e => { console.error('[daily] error:', e.message); process.exit(1); });
