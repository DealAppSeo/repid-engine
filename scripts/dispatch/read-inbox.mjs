#!/usr/bin/env node
/**
 * Read the ai_dispatch inbox, answer what can be answered, reply, and stop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * ai_dispatch is a mailbox with per-agent inbox views and read_at / reply_at /
 * reply_from columns already in place. Nothing has ever read it: every row has
 * read_at NULL and reply_at NULL, going back months. Somebody built a mailbox
 * with read receipts and nobody has ever opened it.
 *
 * That absence is the reason messages keep being written into it and nothing
 * comes back. This is the reader.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE RULE THAT MATTERS
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER MARK A MESSAGE READ WITHOUT PRODUCING A REPLY.
 *
 * An honest "nothing has read this" is a useful signal — it is what made the
 * gap visible. A reader that stamps read_at and returns filler destroys that
 * signal and replaces it with a metric that looks like success. Same defect as
 * a status column reporting 'online' beside a stale ping, and this table
 * already carries that exact bug: rows say status='read' while read_at is NULL
 * and no reply exists.
 *
 * So this reader keys off read_at, never status; claims with a compare-and-swap
 * so two runners cannot both answer one message; writes read_at together with
 * the reply in a single patch; and RELEASES the claim when a handler cannot
 * answer, leaving the message exactly as it found it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *   node scripts/dispatch/read-inbox.mjs --to cc [--limit 5] [--dry-run]
 *
 *   --to <name>    recipient inbox to drain (required)
 *   --limit <n>    max messages this run (default 5)
 *   --dry-run      show the plan, claim nothing, write nothing
 *
 * Requires SUPABASE_URL and a service key in the environment. Without them it
 * exits 2 = NOT_CHECKED, never 0: "no credential" is not "inbox empty".
 *
 * EXIT CODES follow the repo contract: 0 VERIFIED, 2 NOT_CHECKED, else FAILED.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { claimPatch, replyPatch, releasePatch, planFor, formatFleetState } = require('./inbox-lib.js');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const TO = flag('to', null);
const LIMIT = Number(flag('limit', '5'));
const DRY = has('dry-run');

if (!TO) {
  console.error('read-inbox: --to <recipient> is required.');
  process.exit(1);
}

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!URL_BASE || !KEY) {
  console.error('read-inbox — NOT_CHECKED: no Supabase credential in this environment.');
  console.error('This says nothing about whether the inbox has messages. Exiting 2, not 0.');
  process.exit(2);
}

/** A run id so a claim is traceable to the process that made it. */
const RUNNER = `${process.env.DISPATCH_RUNNER || 'read-inbox'}-${process.pid}`;

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`PostgREST ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

/** Turn a {col: value} filter into PostgREST query syntax, handling NULL. */
const toQuery = (filter) =>
  Object.entries(filter)
    .map(([k, v]) => (v === null ? `${k}=is.null` : `${k}=eq.${encodeURIComponent(v)}`))
    .join('&');

// ─── handlers ────────────────────────────────────────────────────────────────
//
// A handler returns a string (the reply) or throws. It must NEVER return a
// placeholder: a tag with no real fulfilment is a promise the system cannot
// keep, and one broken promise teaches the reader that the whole loop is
// theatre. If it cannot answer, it throws and the claim is released.

const handlers = {
  /** #fleet — what is every agent actually doing, from the canonical view. */
  async fleet() {
    const rows = await rest(
      'v_agent_state?select=agent_name,state,evidence,minutes_since_probe,minutes_since_iteration,current_task_id&order=state,agent_name',
    );
    return formatFleetState(rows, new Date().toISOString());
  },
};

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  // UNREAD IS read_at IS NULL. Not status. The status column in this table has
  // demonstrably been set to 'read' on messages that were never read and never
  // answered, so filtering on it would skip exactly the rows worth answering.
  const candidates = await rest(
    `ai_dispatch?select=id,from_ai,to_ai,subject,content,status,priority,created_at` +
      `&to_ai=eq.${encodeURIComponent(TO)}&read_at=is.null` +
      `&order=priority.asc,created_at.asc&limit=${LIMIT}`,
  );

  if (candidates.length === 0) {
    console.log(`read-inbox — VERIFIED. Inbox "${TO}" has no unread messages (read_at IS NULL).`);
    return 0;
  }

  console.log(`read-inbox — ${candidates.length} unread in "${TO}"${DRY ? ' (dry run)' : ''}\n`);

  let replied = 0;
  let unhandled = 0;
  let failed = 0;

  for (const row of candidates) {
    const plan = planFor(row, handlers);
    const label = `#${row.id} ${String(row.subject || '').slice(0, 58)}`;

    if (plan.outcome === 'unhandled') {
      // NOT a failure and NOT a silent skip. Reported, and the message is left
      // untouched so it stays visible as genuinely unanswered.
      console.log(`  UNHANDLED  ${label}\n             ${plan.reason} — left unread, deliberately`);
      unhandled++;
      continue;
    }

    if (DRY) {
      console.log(`  WOULD      ${label}\n             handler #${plan.tag}`);
      continue;
    }

    const claim = claimPatch(row, RUNNER);
    const claimed = await rest(`ai_dispatch?${toQuery(claim.filter)}`, {
      method: 'PATCH',
      body: JSON.stringify(claim.body),
      headers: { Prefer: 'return=representation' },
    });

    if (claimed.length === 0) {
      // Another runner swapped the status first. Not an error.
      console.log(`  SKIPPED    ${label}\n             claimed by another runner`);
      continue;
    }

    try {
      const reply = await plan.handler();
      if (typeof reply !== 'string' || reply.trim() === '') {
        throw new Error('handler returned an empty reply');
      }
      const patch = replyPatch(row, claim.token, reply, RUNNER, new Date().toISOString());
      await rest(`ai_dispatch?${toQuery(patch.filter)}`, { method: 'PATCH', body: JSON.stringify(patch.body) });
      console.log(`  REPLIED    ${label}\n             handler #${plan.tag}, ${reply.length} chars`);
      replied++;
    } catch (err) {
      // Release, so the message is exactly as we found it. A failed handler
      // must never leave a message marked read.
      const rel = releasePatch(row, claim.token);
      await rest(`ai_dispatch?${toQuery(rel.filter)}`, { method: 'PATCH', body: JSON.stringify(rel.body) }).catch(() => {});
      console.log(`  FAILED     ${label}\n             ${err.message} — claim released, still unread`);
      failed++;
    }
  }

  console.log(`\nread-inbox: ${replied} replied, ${unhandled} unhandled, ${failed} failed.`);
  if (unhandled > 0) {
    console.log('UNHANDLED messages are left unread on purpose. A filler reply would turn an');
    console.log('honest "nobody answered this" into a metric that looks like success.');
  }
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`read-inbox — FAILED: ${err.message}`);
    process.exit(1);
  },
);
