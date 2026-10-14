#!/usr/bin/env node
/**
 * status.mjs — phone-friendly ecosystem status (agents / tasks / health) for the Trinity swarm.
 *
 * Two uses:
 *   1. Imported by bridge.mjs → powers the /status /agents /tasks /health Telegram commands (pull).
 *   2. Standalone: `node status.mjs [status|agents|tasks|health]` → pushes that snapshot to the
 *      authorized Telegram chat (proof + a cron-able digest).
 *
 * DB: credential choice lives in db-creds.js (same precedence as the engine's src/config.ts):
 *     SUPABASE_SECRET_KEY (sb_secret_…) → supabase-js REST calling the public.run_sql(sql text)->json RPC;
 *     else DATABASE_URL → pg runs the SQL. Legacy JWT keys are disabled on prod and are not used.
 *     Read-only queries only.
 * Creds: process env first, then .env.master (TRUSTKEYS_ENV_MASTER). Telegram: ~/.telegram-bot-token +
 *     ~/.telegram-chat-id. Values are never printed.
 *
 * All SQL below is schema-verified against live [sql:2026-07-01]. Columns: repid_agents(agent_name,
 * current_repid,tier,lifecycle_status), agent_heartbeat(agent_name,last_ping,loop_count,
 * tasks_completed_session), trinity_tasks(status,claimed_by,claimed_at,completed_at),
 * repid_score_events(created_at,hal_decision,repid_delta_applied), repid_zkp_proofs(created_at,is_real).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { resolveDbCreds } = createRequire(import.meta.url)('./db-creds.js');

const readFile1 = (p) => { try { return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; } catch { return null; } };
const nf = (n) => Number(n ?? 0).toLocaleString('en-US');

// ---- cred resolution: db-creds.js (SUPABASE_SECRET_KEY, else DATABASE_URL; never legacy JWT) ----
const ENV_MASTER = process.env.TRUSTKEYS_ENV_MASTER || 'C:/Users/Cash4/repos/.env.master';
function fromEnvMaster(name) {
  try {
    if (!existsSync(ENV_MASTER)) return null;
    const safe = String(name).replace(/[^A-Z0-9_]/g, '');
    const m = readFileSync(ENV_MASTER, 'utf8').match(new RegExp(`^\\s*${safe}\\s*=\\s*["']?([^"'\\s]+)`, 'm'));
    return m ? m[1] : null;
  } catch { return null; }
}
export function resolveCreds() {
  return resolveDbCreds(process.env, fromEnvMaster);
}

// ---- a runSql(sql) -> row[] over either backend -----------------------------
export async function makeRunSql(creds) {
  if (creds.mode === 'pg') {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: creds.url });
    await c.connect();
    const fn = async (sql) => (await c.query(sql)).rows;
    fn.close = () => c.end();
    return fn;
  }
  if (creds.mode === 'rest') {
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(creds.supaUrl, creds.key, { auth: { persistSession: false } });
    const fn = async (sql) => {
      // run_sql chokes on some multiline SQL (returns a {success:false} envelope); collapse to one
      // line first — verified to work. Safe here: none of these queries use `--` comments.
      const oneLine = sql.replace(/\s+/g, ' ').trim();
      const { data, error } = await sb.rpc('run_sql', { sql: oneLine });
      if (error) throw new Error(error.message);
      if (data && !Array.isArray(data) && data.success === false) throw new Error('run_sql failed: ' + (data.error || JSON.stringify(data)));
      return Array.isArray(data) ? data : (data ? [data] : []);
    };
    fn.close = () => {};
    return fn;
  }
  throw new Error(creds.why || 'no usable DB credential');
}

// ---- section builders (each returns phone-friendly text) --------------------
const ts = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export async function buildStatus(runSql) {
  const [h] = await runSql(`
    SELECT
      (SELECT count(*) FROM repid_agents WHERE lifecycle_status='active') AS agents_active,
      (SELECT count(*) FROM repid_agents) AS agents_total,
      (SELECT count(*) FROM agent_heartbeat WHERE last_ping > now()-interval '30 min') AS alive_30m,
      (SELECT count(*) FROM trinity_tasks WHERE status='pending') AS tasks_pending,
      (SELECT count(DISTINCT claimed_by) FROM trinity_tasks WHERE claimed_at > now()-interval '24h') AS claimers_24h,
      (SELECT count(*) FROM trinity_tasks WHERE completed_at > now()-interval '24h') AS done_24h,
      (SELECT count(*) FROM repid_score_events WHERE created_at > now()-interval '24h') AS events_24h,
      (SELECT count(*) FROM repid_score_events WHERE created_at > now()-interval '24h' AND repid_delta_applied < 0) AS penalties_24h,
      (SELECT count(*) FROM repid_zkp_proofs) AS proofs_total,
      (SELECT to_char(max(created_at),'MM-DD HH24:MI') FROM repid_zkp_proofs) AS proof_last,
      (SELECT round(extract(epoch FROM now()-max(created_at))/3600) FROM repid_zkp_proofs) AS proof_age_h,
      (SELECT to_char(max(created_at),'MM-DD HH24:MI') FROM agent_reports) AS report_last`);
  const flags = [];
  if (Number(h.proof_age_h) > 48) flags.push('⚠ proof-drain stale');
  if (Number(h.penalties_24h) > 300) flags.push('⚠ high penalty rate (purpose-gate not yet deployed → false vetoes)');
  if (Number(h.alive_30m) < 12) flags.push(`⚠ only ${h.alive_30m}/12 core agents pinging`);
  return [
    `📊 AI Trinity — status ${ts()}`,
    `🤖 Agents: ${nf(h.agents_active)} active / ${nf(h.agents_total)} · ${h.alive_30m} alive(30m)`,
    `📋 Tasks: ${nf(h.tasks_pending)} pending · ${h.claimers_24h} claimers/24h · ${nf(h.done_24h)} done/24h`,
    `⚖️ Scoring 24h: ${nf(h.events_24h)} events · ${nf(h.penalties_24h)} penalties`,
    `🔐 Proofs: ${nf(h.proofs_total)} (last ${h.proof_last})`,
    `📝 Last report: ${h.report_last || '—'}`,
    flags.length ? '\n' + flags.join('\n') : '✅ no health flags',
    '\ncmds: /agents /tasks /health',
  ].join('\n');
}

export async function buildAgents(runSql) {
  const rows = await runSql(`
    SELECT h.agent_name AS name, to_char(h.last_ping,'HH24:MI') AS ping,
           coalesce(h.tasks_completed_session,0) AS done, a.current_repid AS repid, a.tier
    FROM agent_heartbeat h
    LEFT JOIN repid_agents a ON a.agent_name = h.agent_name
    WHERE h.last_ping > now()-interval '2 hours'
    ORDER BY a.current_repid DESC NULLS LAST, h.agent_name`);
  const [c] = await runSql(`SELECT
      (SELECT count(*) FROM repid_agents WHERE lifecycle_status='active') active,
      (SELECT count(*) FROM repid_agents) total`);
  const lines = rows.map(r => `${(r.name || '').padEnd(16)} ${String(r.repid ?? '—').padStart(5)} ${(r.tier || '').slice(0, 3)} · ${r.ping} · ${r.done} done`);
  return [`🤖 Live agents (last 2h): ${rows.length}`, '```', ...lines, '```', `Roster: ${nf(c.active)} active / ${nf(c.total)} total`].join('\n');
}

export async function buildTasks(runSql) {
  const [c] = await runSql(`SELECT
      count(*) FILTER (WHERE status='pending') pending,
      count(*) FILTER (WHERE claimed_at > now()-interval '24h') claimed_24h,
      count(DISTINCT claimed_by) FILTER (WHERE claimed_at > now()-interval '24h') claimers_24h,
      count(*) FILTER (WHERE completed_at > now()-interval '24h') completed_24h
    FROM trinity_tasks`);
  const dist = await runSql(`SELECT status, count(*) n FROM trinity_tasks GROUP BY status ORDER BY n DESC LIMIT 8`);
  return [
    '📋 Tasks',
    `pending ${nf(c.pending)} · claimed/24h ${nf(c.claimed_24h)} (${c.claimers_24h} agents) · completed/24h ${nf(c.completed_24h)}`,
    'by status:',
    ...dist.map(d => `  ${(d.status || '(null)').padEnd(14)} ${nf(d.n)}`),
  ].join('\n');
}

export async function buildHealth(runSql) {
  const hal = await runSql(`SELECT coalesce(hal_decision,'(none)') d, count(*) n
    FROM repid_score_events WHERE created_at > now()-interval '24h' GROUP BY hal_decision ORDER BY n DESC`);
  const [p] = await runSql(`SELECT count(*) total, count(*) FILTER (WHERE is_real) real,
    to_char(max(created_at),'MM-DD HH24:MI') last,
    round(extract(epoch FROM now()-max(created_at))/3600) age_h FROM repid_zkp_proofs`);
  const [ev] = await runSql(`SELECT count(*) events, count(*) FILTER (WHERE repid_delta_applied<0) penalties
    FROM repid_score_events WHERE created_at > now()-interval '24h'`);
  return [
    '🩺 Health (24h)',
    `HAL: ${hal.map(x => `${x.d} ${nf(x.n)}`).join(' · ')}`,
    `penalties applied: ${nf(ev.penalties)} / ${nf(ev.events)} events`,
    `proofs: ${nf(p.total)} (${nf(p.real)} real) · last ${p.last} (${p.age_h}h ago)${Number(p.age_h) > 48 ? ' ⚠ drain down' : ''}`,
    Number(ev.penalties) > 300 ? '⚠ penalties dominated by HAL vetoes on non-deliverables — purpose-gate fix built, awaiting Railway deploy' : '',
  ].filter(Boolean).join('\n');
}

export async function buildSection(runSql, which) {
  switch ((which || 'status').toLowerCase()) {
    case 'agents': return buildAgents(runSql);
    case 'tasks': return buildTasks(runSql);
    case 'health': return buildHealth(runSql);
    default: return buildStatus(runSql);
  }
}

// ---- standalone: push the requested section to Telegram ---------------------
async function main() {
  const which = process.argv[2] || 'status';
  const creds = resolveCreds();
  if (creds.mode === 'none') { console.error('[status] ' + creds.why); process.exit(2); }
  const runSql = await makeRunSql(creds);
  let text;
  try { text = await buildSection(runSql, which); }
  finally { try { runSql.close(); } catch {} }

  const TOKEN = readFile1(join(homedir(), '.telegram-bot-token'));
  const CHAT = readFile1(join(homedir(), '.telegram-chat-id'));
  if (!TOKEN || !CHAT) { console.log(text); console.error('[status] no telegram creds — printed above, not sent'); process.exit(0); }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 3900), disable_web_page_preview: true }),
  });
  console.log(r.ok ? `[status] ${which} sent OK` : `[status] send failed ${r.status}`);
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('status.mjs')) {
  main().catch(e => { console.error('[status] error:', e.message); process.exit(1); });
}
