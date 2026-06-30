#!/usr/bin/env node
/**
 * cosign-consumer.mjs — DRAFT (branch only, NOT enabled). Closes the longest-open P0 dispatch gap:
 * run-once.mjs finishes high-consequence / requires_cosign dispatches as status='awaiting_cosign' (run-once.mjs:145),
 * and NOTHING flips them → they sit forever (XC_E2E_CHAIN_VERIFY). This is the consumer that flips
 *   awaiting_cosign → done   (cosign PASS)   |   awaiting_cosign → changes_requested   (cosign BLOCK).
 *
 * GOVERNANCE (peer-ratification v0, consequence-tiered): a high-consequence dispatch requires an OUT-OF-LANE
 * second agent to verify the producer's artifact against ground truth before it lands. The producer never
 * cosigns its own work. Verifier lane is the agent NOT equal to the producer (ga<->xc; claude as arbiter).
 *
 * FAIL-CLOSED: if the artifact is missing → changes_requested. If no verifier verdict can be obtained →
 * LEAVE as awaiting_cosign (do NOT auto-pass) — a cosign that didn't happen must never read as PASS.
 *
 * SAFE BY DEFAULT: DRYRUN unless COSIGN_LIVE=1; never enabled here (Sean/Claude turn it on). Mirrors
 * run-once.mjs cred resolution + atomic claim + tripwire discipline.
 *
 * Usage:  node cosign-consumer.mjs            # DRYRUN: claim+inspect, no verifier spend, no flip
 *         COSIGN_LIVE=1 node cosign-consumer.mjs
 * Env:    COSIGN_VERIFIER=auto|xc|ga|claude   DISPATCH_MAX_RUNTIME_MS   (reuses run-once creds)
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE = ['1', 'true', 'yes'].includes((process.env.COSIGN_LIVE || '').toLowerCase());
const MAX_RUNTIME_MS = parseInt(process.env.DISPATCH_MAX_RUNTIME_MS || '900000', 10);
const VERIFIER_PREF = (process.env.COSIGN_VERIFIER || 'auto').toLowerCase();
// out-of-lane verifier: never the producer. (producer agent_assigned -> verifier CLI)
const VERIFIER_CLI = {
  xc: (f) => `grok --prompt-file "${f}"`,
  ga: (f) => `gemini -p - --approval-mode default < "${f}"`,
};
function pickVerifier(producer) {
  if (VERIFIER_PREF === 'xc' || VERIFIER_PREF === 'ga') return VERIFIER_PREF;
  // auto: opposite lane. GA produced -> XC verifies; XC produced -> GA verifies; else default XC.
  if (String(producer).includes('ga')) return 'xc';
  if (String(producer).includes('xc')) return 'ga';
  return 'xc';
}

// ---- credential resolution (identical contract to run-once.mjs) ------------
function readFirst(paths) { for (const p of paths) { try { if (existsSync(p)) { const v = readFileSync(p, 'utf8').trim(); if (v) return v; } } catch {} } return null; }
function parseFromEnvFiles(re) { for (const p of [join(HERE, '..', '..', '.env.local'), join(HERE, '..', '..', '.env')]) { try { if (existsSync(p)) { const m = readFileSync(p, 'utf8').match(re); if (m) return m[1]; } } catch {} } return null; }
function resolveCreds() {
  if (process.env.DATABASE_URL) return { mode: 'pg', url: process.env.DATABASE_URL };
  const supaUrl = process.env.SUPABASE_URL || parseFromEnvFiles(/SUPABASE_URL\s*=\s*["']?(https?:\/\/[^\s"']+)/);
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
    || readFirst([join(homedir(), '.sb-service-key'), 'C:/Users/Cash4/repos/repid-engine/service_role.txt']);
  if (key && !key.startsWith('eyJ')) key = null;
  if (supaUrl && key) return { mode: 'rest', supaUrl, key };
  return { mode: 'none' };
}

function artifactPresent(dir) { try { return readdirSync(dir).some(f => { try { return statSync(join(dir, f)).size > 0; } catch { return false; } }); } catch { return false; } }

async function makeDb(creds) {
  if (creds.mode === 'pg') {
    const pg = (await import('pg')).default; const c = new pg.Client({ connectionString: creds.url }); await c.connect();
    return {
      // TRIPWIRE: bounded, indexed claim; SKIP LOCKED so two consumers never grab the same row.
      async claim() { const { rows } = await c.query(`UPDATE trinity_tasks SET status='cosigning', claimed_at=now() WHERE id=(SELECT id FROM trinity_tasks WHERE status='awaiting_cosign' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,title,metadata,agent_assigned,claimed_by;`); return rows[0] || null; },
      async report(id) { const { rows } = await c.query(`SELECT report_path,key_findings,agent FROM agent_reports WHERE sprint_id=$1 ORDER BY id DESC LIMIT 1`, [String(id)]); return rows[0] || null; },
      async flip(id, status, reason) { await c.query(`UPDATE trinity_tasks SET status=$2, metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object('cosign_status',$2,'cosign_reason',$3,'cosigned_at',now()::text) WHERE id=$1`, [id, status, reason || null]); },
      async close() { await c.end(); },
    };
  }
  if (creds.mode === 'rest') {
    const { createClient } = await import('@supabase/supabase-js'); const sb = createClient(creds.supaUrl, creds.key, { auth: { persistSession: false } });
    return {
      async claim() {
        const { data: cand } = await sb.from('trinity_tasks').select('id,title,metadata,agent_assigned,claimed_by').eq('status', 'awaiting_cosign').order('id', { ascending: true }).limit(1);
        if (!cand || !cand.length) return null;
        const { data: got } = await sb.from('trinity_tasks').update({ status: 'cosigning', claimed_at: new Date().toISOString() }).eq('id', cand[0].id).eq('status', 'awaiting_cosign').select('id,title,metadata,agent_assigned,claimed_by');
        return (got && got.length) ? got[0] : null;
      },
      async report(id) { const { data } = await sb.from('agent_reports').select('report_path,key_findings,agent').eq('sprint_id', String(id)).order('id', { ascending: false }).limit(1); return (data && data[0]) || null; },
      async flip(id, status, reason) { const { data } = await sb.from('trinity_tasks').select('metadata').eq('id', id).single(); const md = (data && data.metadata) || {}; md.cosign_status = status; md.cosign_reason = reason || null; md.cosigned_at = new Date().toISOString(); await sb.from('trinity_tasks').update({ status, metadata: md }).eq('id', id); },
      async close() {},
    };
  }
  return null;
}

// out-of-lane verifier: hand it the artifact + ask for a strict PASS/BLOCK verdict against ground truth.
function runVerifier(verifier, task, rep) {
  const prompt = `You are ${verifier.toUpperCase()}, the OUT-OF-LANE cosigner. Adversarially verify dispatch #${task.id} ("${task.title}") produced by ${rep.agent}. Read its artifact at: ${rep.report_path}. Check the claims against GROUND TRUTH (files/DB/tests), not the producer's say-so. This is a consequence-tiered cosign: only PASS if the work is real and correct.\nReply with FIRST LINE exactly one of: COSIGN_PASS | COSIGN_BLOCK <one-line reason>.`;
  const pf = join(tmpdir(), `cosign-${task.id}.txt`);
  writeFileSync(pf, prompt, 'utf8');
  const out = execSync(VERIFIER_CLI[verifier](pf), { encoding: 'utf8', shell: true, timeout: MAX_RUNTIME_MS });
  const line = (out || '').split('\n').map(s => s.trim()).find(s => s.startsWith('COSIGN_')) || '';
  if (line.startsWith('COSIGN_PASS')) return { verdict: 'pass' };
  if (line.startsWith('COSIGN_BLOCK')) return { verdict: 'block', reason: line.replace('COSIGN_BLOCK', '').trim() || 'verifier blocked' };
  return { verdict: 'inconclusive', reason: 'no COSIGN_ verdict line' };
}

const creds = resolveCreds();
if (creds.mode === 'none') { console.error('No DB creds.'); process.exit(2); }
const db = await makeDb(creds);
try {
  const task = await db.claim();
  if (!task) { console.log('[cosign] no awaiting_cosign rows. idle.'); await db.close(); process.exit(0); }
  const rep = await db.report(task.id);
  console.log(`[cosign] claimed #${task.id} "${task.title}" (producer=${task.agent_assigned || task.claimed_by})`);

  // Fail-closed structural gate: no artifact → changes_requested.
  if (!rep || !rep.report_path || !artifactPresent(rep.report_path)) {
    if (LIVE) await db.flip(task.id, 'changes_requested', 'no artifact at report_path'); else console.log('[cosign][DRYRUN] would flip → changes_requested (no artifact)');
    console.log(`[cosign] #${task.id} → changes_requested (no artifact)`); await db.close(); process.exit(0);
  }

  const verifier = pickVerifier(task.agent_assigned || task.claimed_by || '');
  if (!LIVE) { console.log(`[cosign][DRYRUN] #${task.id}: would run out-of-lane verifier=${verifier} on ${rep.report_path}; no flip, no spend.`); await db.close(); process.exit(0); }

  let res;
  try { res = runVerifier(verifier, task, rep); }
  catch (e) { console.error(`[cosign] verifier error: ${e.message}`); await db.flip(task.id, 'awaiting_cosign', `verifier_error: ${e.message}`); /* fail-closed: back to awaiting, never auto-pass */ await db.close(); process.exit(1); }

  if (res.verdict === 'pass') { await db.flip(task.id, 'done', `cosign PASS by ${verifier}`); console.log(`[cosign] #${task.id} → done (PASS/${verifier})`); }
  else if (res.verdict === 'block') { await db.flip(task.id, 'changes_requested', `cosign BLOCK by ${verifier}: ${res.reason}`); console.log(`[cosign] #${task.id} → changes_requested (BLOCK/${verifier})`); }
  else { await db.flip(task.id, 'awaiting_cosign', `inconclusive: ${res.reason}`); console.log(`[cosign] #${task.id} stays awaiting_cosign (inconclusive — fail-closed, no auto-pass)`); }
} finally { try { await db.close(); } catch {} }
