/**
 * ai_dispatch reader — the claim/handle/reply loop, as pure-ish functions.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The repo's jest runs CommonJS, so a `.mjs`
 * cannot be `require`d by a test — the same constraint sprint-lib.js was split
 * out for. The logic lives here once: read-inbox.mjs imports it, the test
 * requires it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TABLE LIES IN A SPECIFIC WAY, AND THAT SHAPES EVERYTHING BELOW
 * ─────────────────────────────────────────────────────────────────────────────
 * `ai_dispatch` has BOTH a `status` text column and `read_at` / `reply_at`
 * timestamps. They disagree: rows exist carrying status='read' with read_at
 * NULL, no reply and no reply_at. The label was written without the act it
 * names ever happening, and `status` has no CHECK constraint, so nothing
 * stopped it.
 *
 * That is the same defect as an agent's self-reported status='online' beside a
 * weeks-stale ping. So:
 *
 *   - UNREAD IS `read_at IS NULL`. Never `status = 'unread'`. Reading the label
 *     would silently skip messages that were mislabelled read and never
 *     answered — the exact rows most worth answering.
 *   - `status` is used ONLY as an ephemeral lease token. It already carries no
 *     trustworthy meaning, so borrowing it costs nothing, and a crashed run
 *     leaves a visibly-stale claim rather than a corrupted timestamp.
 *   - `read_at`, `reply`, `reply_at`, `reply_from` are written TOGETHER, once,
 *     on success. They are the durable truth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEVER MARK READ WITHOUT A REPLY
 * ─────────────────────────────────────────────────────────────────────────────
 * A mailbox with read receipts that nothing has ever read is an honest zero. A
 * reader that stamps read_at and produces nothing converts that into a
 * dishonest hundred-percent — the same "reporting success it has not earned"
 * this codebase keeps re-encountering, wearing a friendlier interface.
 *
 * So a handler that cannot answer does not get to mark the message read. The
 * claim is RELEASED and the message stays unread. "No handler for this" is a
 * reported outcome, not a silent skip and not a filler reply.
 */

/** Status value written while a message is claimed but not yet answered. */
const CLAIM_PREFIX = 'claiming:';

/**
 * Compare-and-swap claim.
 *
 * ATOMICITY, and why it is a swap rather than a flag. Two runners can both SELECT
 * a row with read_at IS NULL — the select is not a lock. The claim therefore
 * guards on the status value the runner OBSERVED and swaps it for a unique token.
 * PostgREST issues that as one UPDATE ... WHERE id = N AND status = <observed>,
 * which Postgres serializes: the first runner's write changes status, so the
 * second runner's WHERE no longer matches and it receives zero rows back.
 *
 * Guarding on read_at IS NULL alone would NOT be atomic — both runners' WHERE
 * clauses would still match, and both would proceed to handle the same message.
 *
 * @returns the claim token on success, or null if another runner won the race.
 */
function claimPatch(row, runnerId) {
  const token = `${CLAIM_PREFIX}${runnerId}`;
  return {
    // Filters: id AND the observed status. Both must still hold.
    filter: { id: row.id, status: row.status ?? null },
    body: { status: token },
    token,
  };
}

/** Write applied only when a handler actually produced an answer. */
function replyPatch(row, token, reply, replyFrom, nowIso) {
  return {
    filter: { id: row.id, status: token },
    body: {
      reply,
      reply_at: nowIso,
      reply_from: replyFrom,
      read_at: nowIso, // set WITH the reply, never before it
      status: 'replied',
    },
  };
}

/** Undo a claim so the message returns to the pool exactly as it was. */
function releasePatch(row, token) {
  return {
    filter: { id: row.id, status: token },
    body: { status: row.status ?? null },
  };
}

/**
 * Decide what to do with one message, given the handlers available.
 *
 * Four outcomes, and 'unhandled' is a real one. Collapsing it into 'failed'
 * would hide the difference between "the handler broke" and "nothing here can
 * answer this", which are different problems with different fixes.
 */
function planFor(row, handlers) {
  const tag = detectTag(row);
  const handler = tag ? handlers[tag] : undefined;
  if (!handler) {
    return { outcome: 'unhandled', tag, reason: tag ? `no handler registered for #${tag}` : 'no recognised tag in subject or content' };
  }
  return { outcome: 'handle', tag, handler };
}

/**
 * Find the routing tag. Subject wins over body: a subject is what the sender
 * chose as the summary, and scanning the body first would let a tag quoted
 * inside a longer message hijack the routing.
 *
 * Returns the bare tag name without '#', lowercased, or null.
 */
function detectTag(row) {
  const TAG = /#([a-z][a-z0-9-]{1,30})\b/i;
  const fromSubject = TAG.exec(row.subject ?? '');
  if (fromSubject) return fromSubject[1].toLowerCase();
  const fromBody = TAG.exec(row.content ?? '');
  return fromBody ? fromBody[1].toLowerCase() : null;
}

/**
 * Format the fleet-state answer.
 *
 * Kept here rather than in the handler so it is testable without a database,
 * and so the "unknown is not down" rule is asserted by a test rather than
 * living only in a comment.
 */
function formatFleetState(rows, nowIso) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      `NOT_CHECKED at ${nowIso} — v_agent_state returned no rows.\n` +
      'No probe landed inside the freshness window. That means the fleet could ' +
      'not be observed, NOT that it is down. Check whether the prober is running ' +
      'before concluding anything.'
    );
  }
  const tally = {};
  for (const r of rows) tally[r.state] = (tally[r.state] || 0) + 1;
  const summary = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');

  const lines = rows.map((r) => {
    const task = r.current_task_id ? `task=${r.current_task_id}` : 'no task';
    return `  ${String(r.agent_name).padEnd(18)} ${String(r.state).padEnd(8)} ${task} — ${r.evidence}`;
  });

  return (
    `MEASURED at ${nowIso} — ${rows.length} agents: ${summary}\n\n` +
    lines.join('\n') +
    '\n\nSource: v_agent_state (canonical). "unknown" means not observed, never ' +
    '"down". This is a dated snapshot; re-query before quoting it later.'
  );
}

module.exports = {
  CLAIM_PREFIX,
  claimPatch,
  replyPatch,
  releasePatch,
  planFor,
  detectTag,
  formatFleetState,
};
