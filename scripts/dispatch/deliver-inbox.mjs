#!/usr/bin/env node
/**
 * THE DELIVERER. Takes a triaged ai_dispatch row, actually runs the agent on it,
 * verifies what happened independently, and writes exactly one honest reply.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS MISSING, AND WHY THIS IS SMALL
 * ─────────────────────────────────────────────────────────────────────────────
 * Both halves of this already existed and did not touch:
 *
 *   claude-cloud --writes--> ai_dispatch (Supabase)
 *                                 |
 *                        dispatch-triage stamps it        <- works, external
 *                                 |
 *                                 X   NOTHING BRIDGED HERE
 *                                 |
 *   docs/dispatch/INBOX_XC.md --> run-agent.mjs --> grok -p   <- works, proven in CI
 *
 * docs/dispatch/MAILBOX_DELIVERY.md states it outright: "a deliverer has never
 * existed, and the ledger shows that was a considered decision rather than an
 * oversight." So the queue an agent writes into was never the queue the working
 * automation reads from. This file is the bridge and nothing else: run-agent.mjs
 * and inbox-lib.js are reused UNCHANGED, and every guarantee they already make
 * (capability refusal, evidence fencing, claim audit, secret pruning,
 * safe-repo-state) still applies exactly as before.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SELECTOR IS DELIBERATELY NOT `read_at IS NULL`
 * ─────────────────────────────────────────────────────────────────────────────
 * read-inbox.mjs selects that way and is consequently BLIND: dispatch-triage
 * stamps read_at within ~7 minutes of a write, so a read_at selector matches
 * zero rows on any schedule coarser than that window, and its zero-row branch
 * used to print VERIFIED. This selector instead treats the triage stamp as the
 * READY signal — status='triaged' AND reply_from='dispatch-triage' — which is
 * the state a row actually sits in when it is waiting for a real agent. Rows
 * newer than MIN_AGE_MIN are left alone so triage has settled first.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFICATION: THE AGENT'S OWN "DONE" IS NOT EVIDENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * This system has caught fabricated completions twice — a self-reported task
 * quoting a deployed_commit that did not exist, and a claimed HTTP 200 against
 * an endpoint that 404'd (lessons_learned #165). So the reply this writes is
 * built from things checked HERE, after the run: the dispatcher's exit code, a
 * transcript file that actually appeared on disk, and the repo's own git state.
 * Whatever the agent said about itself is carried as a CLAIM, clearly labelled,
 * never as the verdict.
 *
 * Exit codes follow the house convention: 0 VERIFIED, 2 NOT_CHECKED, else FAILED.
 *
 * Usage:
 *   node scripts/dispatch/deliver-inbox.mjs [--to xc,xc2] [--limit 1] [--dry-run]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { claimPatch, replyPatch, releasePatch } = require_('./inbox-lib.js');
const { AGENT_FOR, buildReply } = require_('./deliver-lib.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');


const MIN_AGE_MIN = Number(process.env.DISPATCH_MIN_AGE_MIN || 10);
const DRY = process.argv.includes('--dry-run');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const TO = arg('to', 'xc,xc2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = Number(arg('limit', '1'));

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

/**
 * Preconditions, checked when the CLI RUNS rather than when the module loads.
 *
 * At module scope these were a `process.exit` on import, which makes the file
 * impossible to unit-test — the same shape as a module-scope Supabase client,
 * which broke every deployment of a sibling project for two months.
 */
function checkPreconditions() {
  if (!URL_BASE || !KEY) {
    return { code: 2, msg:
      'deliver-inbox — NOT_CHECKED: no Supabase credential in this environment.\n' +
      'This says nothing about whether anything is queued. Exiting 2, not 0.' };
  }
  const unknown = TO.filter((t) => !AGENT_FOR[t]);
  if (unknown.length) {
    return { code: 1, msg: `deliver-inbox — FAILED: no agent mapped for ${unknown.join(', ')}.` };
  }
  return null;
}

const RUNNER_BASE = process.env.DISPATCH_RUNNER || 'deliver-inbox';
const RUNNER = `${RUNNER_BASE}-${process.pid}`;

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

const toQuery = (filter) =>
  Object.entries(filter)
    .map(([k, v]) => (v === null ? `${k}=is.null` : `${k}=eq.${encodeURIComponent(v)}`))
    .join('&');

/** Repo state before the run, so "did anything change" is answerable afterwards. */
function gitSnapshot() {
  const g = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  };
  return { head: g(['rev-parse', 'HEAD']), status: g(['status', '--porcelain']) };
}

/**
 * Run the EXISTING dispatcher against one row's content.
 *
 * The content is written to a temp file and passed with --inbox <path>, so
 * nothing is committed to docs/dispatch/ just to hand a prompt over, and the
 * prompt never reaches a shell command line.
 */
function dispatch(agentKey, content) {
  const dir = mkdtempSync(join(tmpdir(), 'deliver-inbox-'));
  const file = join(dir, `INBOX_${agentKey.toUpperCase()}.md`);
  writeFileSync(file, content, 'utf8');
  try {
    const res = spawnSync(
      process.execPath,
      [
        join(HERE, 'run-agent.mjs'),
        '--agent', agentKey,
        '--inbox', file,
        '--requires', 'reasoning,repo_read',
      ],
      { cwd: REPO, encoding: 'utf8', timeout: 20 * 60 * 1000 },
    );
    return {
      code: res.status,
      stdout: (res.stdout || '').slice(-4000),
      stderr: (res.stderr || '').slice(-4000),
      spawnError: res.error ? String(res.error.message) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const sinceIso = new Date(Date.now() - MIN_AGE_MIN * 60_000).toISOString();
  const inList = `(${TO.map((t) => `"${t}"`).join(',')})`;

  const candidates = await rest(
    `ai_dispatch?select=id,from_ai,to_ai,subject,content,status,priority,created_at` +
      `&to_ai=in.${encodeURIComponent(inList)}` +
      `&status=eq.triaged&reply_from=eq.dispatch-triage` +
      `&created_at=lt.${encodeURIComponent(sinceIso)}` +
      `&order=priority.desc,created_at.asc&limit=${LIMIT}`,
  );

  if (!candidates.length) {
    console.log(
      `deliver-inbox — VERIFIED. Nothing ready for ${TO.join('/')}: ` +
        `no row is both triaged-by-dispatch-triage and older than ${MIN_AGE_MIN}m.`,
    );
    return 0;
  }

  console.log(`deliver-inbox — ${candidates.length} ready${DRY ? ' (dry run)' : ''}\n`);
  let delivered = 0;
  let blocked = 0;

  for (const row of candidates) {
    const agentKey = AGENT_FOR[row.to_ai];
    console.log(`#${row.id} p${row.priority ?? '-'} -> ${row.to_ai} (${agentKey}): ${row.subject}`);

    if (DRY) {
      console.log('  dry run — not claimed, not dispatched.\n');
      continue;
    }

    const claim = claimPatch(row, RUNNER);
    const claimed = await rest(`ai_dispatch?${toQuery(claim.filter)}`, {
      method: 'PATCH',
      body: JSON.stringify(claim.body),
      headers: { Prefer: 'return=representation' },
    });
    if (!claimed.length) {
      console.log('  another runner claimed it first — skipping.\n');
      continue;
    }

    const before = gitSnapshot();
    let run;
    try {
      run = dispatch(agentKey, row.content);
    } catch (err) {
      const rel = releasePatch(row, claim.token);
      await rest(`ai_dispatch?${toQuery(rel.filter)}`, {
        method: 'PATCH',
        body: JSON.stringify(rel.body),
      }).catch(() => {});
      console.error(`  FAILED to dispatch, claim released: ${err.message}\n`);
      blocked++;
      continue;
    }
    const after = gitSnapshot();

    const { ok, text } = buildReply({ row, agentKey, run, before, after, runner: RUNNER });
    const patch = replyPatch(row, claim.token, text, RUNNER_BASE, new Date().toISOString());
    patch.body.status = ok ? 'done' : 'blocked';
    await rest(`ai_dispatch?${toQuery(patch.filter)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch.body),
    });

    console.log(`  ${ok ? 'done' : 'blocked'} — reply written.\n`);
    ok ? delivered++ : blocked++;
  }

  console.log(`deliver-inbox: ${delivered} delivered, ${blocked} blocked.`);
  return blocked > 0 ? 1 : 0;
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const bad = checkPreconditions();
  if (bad) {
    console.error(bad.msg);
    process.exit(bad.code);
  }
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`deliver-inbox — FAILED: ${err.message}`);
      process.exit(1);
    });
}
