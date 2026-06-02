/**
 * S-SPINE Phase 7 — public security posture.
 *
 * GET /security/status → verifiable security posture. Values are computed LIVE where possible
 * (RLS coverage from pg_class, audit-chain integrity via the server-side recompute) so the
 * endpoint can't drift into stale marketing claims. Items that can't be queried live (code-audit
 * fixes in flight, last test-gate numbers) are reported with an explicit `status` / `as_of` and
 * are NOT asserted as deployed unless true on this branch.
 *
 * Mounted BEFORE authMiddleware (public). Degrades gracefully if the DB pooler is unavailable.
 */
import { Router, Request, Response } from 'express';
import { pgQuery } from '../db/direct-pg';
import { verifyChainBreaks } from '../services/audit/verify-chain-db';

const router = Router();

// Last verified local gate (update when the gate is re-run). Reported with as_of so it can't
// masquerade as live CI.
const LAST_GATE = { tsc_errors: 0, tests_passing: 1278, as_of: '2026-06-02', source: 'local gate on main' };

async function rlsCoverage(): Promise<{ total_tables: number; rls_enabled: number; rls_disabled: number } | null> {
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) return null;
  try {
    const rows = await pgQuery<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE c.relrowsecurity)::int AS enabled
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = 'public'`,
      [], { timeoutMs: 6000, retries: 1, label: 'rls-coverage' },
    );
    const r = rows[0];
    if (!r) return null;
    return { total_tables: r.total, rls_enabled: r.enabled, rls_disabled: r.total - r.enabled };
  } catch { return null; }
}

router.get('/security/status', async (_req: Request, res: Response) => {
  const [rls, halChain, toolChain] = await Promise.all([
    rlsCoverage(),
    verifyChainBreaks('hal_classifications'),
    verifyChainBreaks('tool_call_log'),
  ]);

  const chains = [halChain, toolChain].filter(Boolean) as NonNullable<typeof halChain>[];
  const totalEntries = chains.reduce((s, c) => s + c.total_rows, 0);
  const anyBreak = chains.some((c) => c.breaks > 0);
  const chainStatus = chains.length === 0 ? 'UNVERIFIED' : anyBreak ? 'CHAIN_BREAK' : 'VALID';

  res.json({
    rls_status: rls
      ? {
          total_tables: rls.total_tables,
          rls_enabled: rls.rls_enabled,
          rls_disabled: rls.rls_disabled,
          coverage: rls.total_tables ? `${Math.round((rls.rls_enabled / rls.total_tables) * 100)}%` : 'n/a',
        }
      : { status: 'UNVERIFIED', note: 'DB pooler unavailable in this environment' },

    audit_trail: {
      hash_chain_status: chainStatus,
      total_entries: totalEntries,
      tables_chained: chains.map((c) => ({ table: c.table, rows: c.total_rows, breaks: c.breaks })),
      ...(chains.length === 0 ? { note: 'chain recompute needs the DB pooler (DATABASE_URL)' } : {}),
    },

    authentication: {
      // Live-true: RLS denies anon/authenticated writes when coverage is full.
      anon_write_blocked: rls ? rls.rls_disabled === 0 : null,
      // In-flight code audits — reported truthfully by merge state, NOT asserted as deployed.
      f2_agent_spoofing_fix: 'pending_merge (PR #78)',
      ipv6_rate_limit_fix: 'pending_merge (PR #78)',
    },

    tests: {
      tsc_errors: LAST_GATE.tsc_errors,
      total_passing: LAST_GATE.tests_passing,
      as_of: LAST_GATE.as_of,
      source: LAST_GATE.source,
      note: 'last local gate, not live CI',
    },

    last_updated: new Date().toISOString(),
  });
});

export default router;
