/**
 * Agent coordination helpers (sprint 2026-05-29) — writeReport + claimDispatch.
 *
 * Both write via pgQuery (direct-pg), i.e. as the `postgres` pooler role, which
 * has rolbypassrls=true. So RLS does NOT gate these helpers — RLS is the PUBLIC
 * boundary (anon/authenticated denied; verified live). The dispatch EXECUTION
 * GATE (approved_by_sean) is therefore enforced HERE in SQL, not relied on at
 * RLS for the bypass role. See migrations/DRAFT_2026-05-29_agent_coordination_rls.sql.
 *
 * Tables are Sean-applied (the DDL/policies in that draft are NOT auto-applied).
 * claimDispatch returns null gracefully if dispatch_queue does not yet exist.
 */
import { pgQuery } from '../db/direct-pg';

export interface WriteReportInput {
  sprintId: string;
  agent: string;             // 'CC' | 'GA' | 'XC' | ...
  status: string;            // e.g. 'complete' | 'in_progress' | 'blocked'
  reportPath?: string | null;
  keyFindings?: string | null;
  flagsForSean?: unknown;    // serialized to jsonb
  verifiedBy?: string | null;
}

export interface AgentReportRow {
  id: string;
  sprint_id: string;
  agent: string;
  status: string;
  created_at: string;
}

/**
 * Insert an agent_reports row. Returns the created row. Writes as the backend
 * (postgres, RLS-bypass) — anon cannot do this (RLS 42501), proven live.
 */
export async function writeReport(input: WriteReportInput): Promise<AgentReportRow> {
  const rows = await pgQuery<AgentReportRow>(
    `INSERT INTO public.agent_reports
       (sprint_id, agent, status, report_path, key_findings, flags_for_sean, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, sprint_id, agent, status, created_at`,
    [
      input.sprintId,
      input.agent,
      input.status,
      input.reportPath ?? null,
      input.keyFindings ?? null,
      input.flagsForSean == null ? null : JSON.stringify(input.flagsForSean),
      input.verifiedBy ?? null,
    ],
    { retries: 2, label: 'writeReport' },
  );
  if (!rows[0]) throw new Error('[agent-coordination] writeReport returned no row');
  return rows[0];
}

export interface ClaimDispatchInput {
  agent: string;             // who is claiming
  dispatchType?: string;     // optional filter
}

export interface DispatchRow {
  id: string;
  sprint_id: string;
  dispatch_type: string;
  target_agent: string | null;
  payload: unknown;
  status: string;
  approved_by_sean: boolean;
  claimed_by: string | null;
  claimed_at: string | null;
}

/**
 * Atomically claim the oldest claimable dispatch for `agent` and mark it
 * 'claimed'. The EXECUTION GATE is enforced here: only rows with
 * approved_by_sean = true AND status = 'pending' are eligible. A dispatch may
 * be pinned to one agent via target_agent (NULL = any). FOR UPDATE SKIP LOCKED
 * makes concurrent claimers race-safe. Returns null when nothing is claimable.
 */
export async function claimDispatch(input: ClaimDispatchInput): Promise<DispatchRow | null> {
  const rows = await pgQuery<DispatchRow>(
    `UPDATE public.dispatch_queue d
        SET status = 'claimed', claimed_by = $1, claimed_at = now(), updated_at = now()
      WHERE d.id = (
        SELECT id FROM public.dispatch_queue
         WHERE status = 'pending'
           AND approved_by_sean = true                       -- EXECUTION GATE
           AND ($2::text IS NULL OR dispatch_type = $2)
           AND (target_agent IS NULL OR target_agent = $1)
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, sprint_id, dispatch_type, target_agent, payload, status, approved_by_sean, claimed_by, claimed_at`,
    [input.agent, input.dispatchType ?? null],
    { retries: 2, label: 'claimDispatch' },
  );
  return rows[0] ?? null;
}
