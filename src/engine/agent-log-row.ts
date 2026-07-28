/**
 * The write contract for `trinity_agent_logs`, in ONE place.
 *
 * Deliberately dependency-free — it imports nothing, and in particular not `../db`, so that pure
 * modules (e.g. `services/repid-active-gate`, which takes its `db` as a parameter precisely to
 * stay testable without credentials) can honour the contract without acquiring the db singleton.
 *
 * WHY THIS EXISTS — the failure it encodes was found in production, not in review:
 *
 *   `trinity_agent_logs.agent` is `text NOT NULL` with NO default, and the event discriminator
 *   column is `action` — there is no `event_type` column. Every insert in this codebase that
 *   omitted `agent` failed with `23502`, and the one that named `event_type` also failed `42703`.
 *   All of them were inside best-effort `catch` blocks or `if (error) console.error(...)`, so the
 *   failures were invisible: six audit actions — `zkp_proof_generated`, `zkp_proof_verified`,
 *   `dag_node_verified`, `zkp_batch_generated`, `repid_score_changed`, `repid_gate_shadow` —
 *   wrote ZERO rows for the entire lifetime of the table while appearing to work.
 *
 *   The natural control is `middleware/auth.ts`: same helper, same table, same deploy, and it DOES
 *   supply `agent` — 29,581 rows in 30 days against 0 for every writer that omits it.
 *
 * The dangerous part was never the missing rows; it was that an empty audit log reads as "nothing
 * happened" rather than "nothing was recorded". A gate running in shadow mode whose shadow log is
 * silently empty looks exactly like a gate that found no problems.
 *
 * Hence: required at the TYPE level, so omission is a compile error rather than a silent no-op.
 */
export interface AgentLogRow {
  /** REQUIRED — `trinity_agent_logs.agent` is NOT NULL with no default. Omitting it fails 23502. */
  agent: string;
  /** REQUIRED — the discriminator column is `action`. Naming `event_type` instead fails 42703. */
  action: string;
  metadata?: Record<string, unknown> | null;
  [column: string]: unknown;
}

/**
 * Construct a `trinity_agent_logs` row. The type is the primary guard; these runtime checks catch
 * the callers that reach this through an `any` (the raw supabase client is typed loosely, and at
 * least one call site passes its `db` in as `any`).
 */
export function buildAgentLogRow(row: AgentLogRow): AgentLogRow {
  if (!row.agent) {
    throw new Error('[agent-log] `agent` is required — trinity_agent_logs.agent is NOT NULL (omitting it fails 23502)');
  }
  if (!row.action) {
    throw new Error('[agent-log] `action` is required — there is no event_type column (naming it fails 42703)');
  }
  if ('event_type' in row) {
    throw new Error('[agent-log] `event_type` is not a column on trinity_agent_logs — use `action` (naming it fails 42703)');
  }
  return row;
}
