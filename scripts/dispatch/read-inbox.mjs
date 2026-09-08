#!/usr/bin/env node
/**
 * Read the ai_dispatch inbox, answer what can be answered, reply, and stop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * ai_dispatch is a mailbox with per-agent inbox views and read_at / reply_at /
 * reply_from columns already in place. This is the reader.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS HEADER USED TO SAY "NOTHING HAS EVER READ IT". THAT IS NOW FALSE.
 * ─────────────────────────────────────────────────────────────────────────────
 * When this file was written (#486) the claim was true and it was the whole
 * reason the file exists: every row had read_at NULL going back months.
 *
 * MEASURED 2026-09-08 against the live table, and it has inverted completely:
 *
 *   48 of 48 rows have read_at set. 48 of 48 have reply_at set.
 *   There is exactly ONE distinct reply_from in the entire table: `dispatch-triage`.
 *   It began at 2026-08-31T15:30Z and BACKFILLED every row back to 2026-04-04.
 *   Every row now carries status='triaged'.
 *   Its reply is a fixed form: "TRIAGE — automated. Content was read as DATA and
 *   NOT executed. […] needs a reply from a human/agent: YES".
 *
 * `dispatch-triage` is NOT in this repository — the string appears nowhere in
 * the working tree and nowhere in the full git history. It is an external
 * writer against the same table.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THAT DOES TO THIS SCRIPT — READ THIS BEFORE TRUSTING ITS OUTPUT
 * ─────────────────────────────────────────────────────────────────────────────
 * This reader's candidate query is `read_at IS NULL`. The triager stamps
 * read_at on every message within minutes of arrival. So this script matches
 * zero rows for every inbox OUTSIDE a ~7-minute window -- the gap between a
 * write and the triager stamping it -- and its zero-candidate branch used to
 * print:
 *
 *     "VERIFIED. Inbox has no unread messages"
 *
 * DO NOT read a candidate found inside that window as evidence this is fixed.
 * An earlier draft of this comment said "ZERO rows, permanently". That word is
 * wrong in the direction that costs the most: run this script within seven
 * minutes of a write, see a row, and discard a real defect as overstated.
 * MEASURED 2026-09-08T20:40Z -- row 49 was unstamped at that moment while the
 * other 48 were triaged. The defect is that a reader on any schedule coarser
 * than the window, or running after triage, sees nothing and calls it success.
 *
 * That is a false green, and it is the SAME defect this file was written to
 * prevent, arriving from the other side. The header above warns that a reader
 * which stamps read_at and returns filler converts an honest zero into a
 * dishonest hundred-percent. A third party now does exactly that, and this
 * script's own success message launders it. LESSONS rule 6: a check that cannot
 * fail is a liability.
 *
 * So the empty case now DISCRIMINATES (see `main`): an inbox with no rows at all
 * is a true VERIFIED 0; an inbox whose rows were all stamped read by somebody
 * other than this reader is NOT_CHECKED (exit 2), because this reader can no
 * longer observe whether anything was addressed to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STILL MISSING — AND IT WAS NEVER BUILT, IT DID NOT BREAK
 * ─────────────────────────────────────────────────────────────────────────────
 * The mailbox has a WRITER (agents insert rows), a TRIAGER (external,
 * classifies and stops), and this READER (answers `#tag` questions it can
 * answer from the database). It has NO DELIVERER: nothing carries a triaged
 * message the last step to the agent that should act on it. The triager's own
 * reply says "needs a reply from a human/agent: YES" and then nothing consumes
 * that verdict.
 *
 * No deliverer was ever built. Evidence, not inference: no file matching
 * deliver* has ever existed in this repository's history; #486 (the only commit
 * that has ever touched this script) shipped the reader, its library and its
 * test and nothing else; and `reports/2026-07-25/AUTONOMOUS_LOOP_LEDGER.md`
 * records the gap being named and deliberately left open — "I have no verified
 * path from 'agent produces text' to 'repo artifact a verifier can check' […]
 * It needs a real dispatch→artifact→verify loop designed first."
 *
 * See `docs/dispatch/MAILBOX_DELIVERY.md` for the full path and what has to
 * invoke this script.
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
 *   npm run dispatch:read-inbox -- --to cc [--limit 5] [--dry-run]
 *   node scripts/dispatch/read-inbox.mjs --to cc [--limit 5] [--dry-run]
 *
 * The npm script exists so this file is DISCOVERABLE. It is deliberately NOT a
 * `check:*` script: `npm run check` runs those with no Supabase credential, and
 * a network-dependent drain is not a build gate. Nothing invokes it on a
 * schedule — see `docs/dispatch/MAILBOX_DELIVERY.md`, which names that as the
 * open gap rather than inventing a scheduler for it.
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
const { claimPatch, replyPatch, releasePatch, planFor, classifyEmptyInbox, formatFleetState } = require('./inbox-lib.js');

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
const RUNNER_BASE = process.env.DISPATCH_RUNNER || 'read-inbox';
const RUNNER = `${RUNNER_BASE}-${process.pid}`;

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
    // ZERO UNREAD HAS TWO CAUSES AND THEY ARE NOT THE SAME RESULT.
    //
    // Cause A: nothing was ever addressed to this inbox. A true VERIFIED 0.
    // Cause B: something else stamped read_at on every row before this reader
    //   saw them. Then "no unread" means "I cannot see my own mail", which is
    //   NOT_CHECKED — and printing VERIFIED over it is the false green the
    //   header describes. As of 2026-09-08, cause B is what actually holds:
    //   `dispatch-triage` stamps read_at within minutes and backfilled the
    //   whole table.
    //
    // Distinguished by WHO stamped it, which is the only evidence that
    // separates them. Rows this reader answered carry reply_from = RUNNER.
    // Classification lives in inbox-lib.js so a CJS test can require it — the
    // same constraint that split that file out. Logic here would be untestable.
    const stamped = await rest(
      `ai_dispatch?select=reply_from&to_ai=eq.${encodeURIComponent(TO)}&read_at=not.is.null`,
    );
    const verdict = classifyEmptyInbox(stamped, RUNNER_BASE);

    if (verdict.outcome === 'empty') {
      console.log(`read-inbox — VERIFIED. Inbox "${TO}" is empty: no messages at all, read or unread.`);
      return 0;
    }

    if (verdict.outcome === 'ours') {
      console.log(
        `read-inbox — VERIFIED. Inbox "${TO}" has no unread messages; ` +
          `all ${verdict.total} read row(s) were answered by this reader.`,
      );
      return 0;
    }

    console.error(`read-inbox — NOT_CHECKED. Inbox "${TO}" reports 0 unread, but that is not an empty inbox.`);
    console.error(`  ${verdict.total} row(s) already have read_at set, stamped by: ${verdict.foreign.join(', ')}.`);
    console.error('  This reader keys off `read_at IS NULL`, so a third party that stamps read_at');
    console.error('  makes every message invisible to it. "0 unread" here means "I cannot observe');
    console.error('  this inbox", not "nothing was sent". Exiting 2, not 0.');
    console.error('  See docs/dispatch/MAILBOX_DELIVERY.md.');
    return 2;
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
