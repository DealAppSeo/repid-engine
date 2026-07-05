import { db } from '../db';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';

export interface MCPCallInput {
  agentId: string;
  toolName: string;
  params: Record<string, unknown>;
}

export interface MCPCallResult {
  allowed: boolean;
  toolName: string;
  constitutionalCue: string;
  easAttestationId: string;
  // null when the constitutional audit did not actually run (stub disabled) —
  // never report a placeholder as if it were a measured score (RULE-4).
  complianceScore: number | null;
  requiresConservatorApproval: boolean;
  repidBonusEligible: number;
  latencyMs: number;
  result?: unknown;
  blockedReason?: string;
  costUsd?: number;
}

// ── Firecrawl real-client configuration (CC2 2026-05-26) ──────────────────────
// Firecrawl is the first registry tool with a REAL client (others remain Phase-1
// stubs). Everything is env-driven so Sean controls rollout from Railway:
//   FIRECRAWL_API_KEY            — required to make real calls (unset → graceful block)
//   FIRECRAWL_ALLOWED_AGENT_IDS  — CSV scope allowlist (default: trinity-nexus, trinity-torch)
//   FIRECRAWL_RATE_LIMIT_PER_HOUR — per-agent cap (default 20)
//   FIRECRAWL_USD_PER_CREDIT     — credit→USD for cost tracking (default 0.00083 ≈ Standard plan)
//   FIRECRAWL_API_BASE           — override base URL (default https://api.firecrawl.dev)
const FIRECRAWL_API_BASE = process.env.FIRECRAWL_API_BASE || 'https://api.firecrawl.dev';
const FIRECRAWL_USD_PER_CREDIT = Number(process.env.FIRECRAWL_USD_PER_CREDIT ?? '0.00083');
const FIRECRAWL_RATE_LIMIT_PER_HOUR = Number(process.env.FIRECRAWL_RATE_LIMIT_PER_HOUR ?? '20');
// Initial access scope: research-oriented agents only (cost control during rollout).
// Defaults are the production UUIDs for trinity-nexus + trinity-torch; override via env.
const FIRECRAWL_DEFAULT_SCOPE = [
  '848da285-93c5-4e99-a989-3d9e49ebed09', // trinity-nexus
  '9c0dc740-8c16-4862-ad62-9ba3d515369d', // trinity-torch
];

function firecrawlAllowedAgents(): Set<string> {
  const env = process.env.FIRECRAWL_ALLOWED_AGENT_IDS;
  const ids = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : FIRECRAWL_DEFAULT_SCOPE;
  return new Set(ids);
}

// Per-agent rate limit, counted against trinity_tool_usage (works across server
// instances — no in-memory state). Returns true if the agent is over budget.
async function firecrawlRateExceeded(agentId: string): Promise<boolean> {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await db
    .from('trinity_tool_usage')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('tool_name', 'firecrawl')
    .gte('created_at', since);
  return (count ?? 0) >= FIRECRAWL_RATE_LIMIT_PER_HOUR;
}

interface FirecrawlOutcome {
  ok: boolean;
  result?: unknown;
  costCredits: number;
  costUsd: number;
  action: string;
  error?: string;
}

// Real Firecrawl REST call. `params` shape:
//   { action?: 'scrape'|'search', url?, query?, formats?, limit? }
// Falls back to 'search' when a query is present, otherwise 'scrape'.
async function executeFirecrawl(params: Record<string, unknown>): Promise<FirecrawlOutcome> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  const action = (params.action as string) || (params.query ? 'search' : 'scrape');
  if (!apiKey) {
    return { ok: false, costCredits: 0, costUsd: 0, action, error: 'FIRECRAWL_API_KEY not configured (set on Railway to enable real calls)' };
  }
  let path: string;
  let body: Record<string, unknown>;
  if (action === 'search') {
    path = '/v2/search';
    body = { query: String(params.query ?? ''), limit: Number(params.limit ?? 5) };
  } else {
    path = '/v2/scrape';
    body = { url: String(params.url ?? ''), formats: (params.formats as string[]) ?? ['summary'] };
  }

  let resp: Response;
  try {
    resp = await fetch(`${FIRECRAWL_API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, costCredits: 0, costUsd: 0, action, error: `Firecrawl network error: ${(e as Error).message}` };
  }

  const json: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { ok: false, costCredits: 0, costUsd: 0, action, error: `Firecrawl ${resp.status}: ${JSON.stringify(json).slice(0, 200)}` };
  }
  // Prefer the provider's reported credit usage; otherwise estimate (1/scrape, limit/search).
  const estimated = action === 'search' ? Number(body.limit ?? 5) : 1;
  const costCredits = Number(json.creditsUsed ?? json.credits_used ?? estimated);
  const costUsd = Number((costCredits * FIRECRAWL_USD_PER_CREDIT).toFixed(6));
  return { ok: true, result: json.data ?? json, costCredits, costUsd, action };
}

// Uses repid_mcp_tools (agent-facing tool registry) — separate from
// trinity_mcp_registry, which is the Trinity Symphony MCP server discovery table.
export async function callMCPWithGuardrails(
  input: MCPCallInput
): Promise<MCPCallResult> {
  const start = Date.now();
  const isFirecrawl = input.toolName === 'firecrawl';

  const { data: tool } = await db
    .from('repid_mcp_tools')
    .select('*')
    .eq('tool_name', input.toolName)
    .eq('approved', true)
    .single();

  if (!tool) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: '',
      easAttestationId: '',
      complianceScore: 0,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs: Date.now() - start,
      blockedReason: `Tool '${input.toolName}' not in approved MCP registry`,
    };
  }

  // ── Firecrawl access scope (cost control during rollout) ──
  if (isFirecrawl && !firecrawlAllowedAgents().has(input.agentId)) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: '',
      complianceScore: 0,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs: Date.now() - start,
      blockedReason: `Agent ${input.agentId} is outside the Firecrawl access scope (research agents only during rollout)`,
    };
  }

  // ── Firecrawl per-agent rate limit ──
  if (isFirecrawl && (await firecrawlRateExceeded(input.agentId))) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: '',
      complianceScore: 0,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs: Date.now() - start,
      blockedReason: `Firecrawl rate limit reached for ${input.agentId} (${FIRECRAWL_RATE_LIMIT_PER_HOUR}/hour)`,
    };
  }

  const audit = await auditConstitutionalCompliance({
    agentId: input.agentId,
    actionType: `MCP_CALL:${input.toolName}`,
    actionMetadata: { toolName: input.toolName, params: input.params },
  });

  // RULE-4 gate (2026-07-05): the constitutional audit is a NON-LOAD-BEARING stub
  // (always passes with a hardcoded 1.0). While CONSTITUTIONAL_AUDIT_ENABLED is
  // off, `audit.enabled` is false — we must NOT gate tool execution on its fake
  // `passed`, and must NOT persist its placeholder 1.0 as a measured score.
  const auditActive = audit.enabled;
  // Honest value to store/return: null when the audit did not actually run.
  const reportedComplianceScore = auditActive ? audit.complianceScore : null;

  if (tool.requires_conservator_approval) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: audit.easAttestationId,
      complianceScore: reportedComplianceScore,
      requiresConservatorApproval: true,
      repidBonusEligible: tool.repid_bonus,
      latencyMs: Date.now() - start,
      blockedReason: 'Conservator approval required — notify Sean before proceeding',
    };
  }

  // Only gate on the audit when it is actually a real measurement (flag on).
  if (auditActive && !audit.passed) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: audit.easAttestationId,
      complianceScore: audit.complianceScore,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs: Date.now() - start,
      blockedReason: `Constitutional compliance failed: ${audit.complianceScore}`,
    };
  }

  // ── Dispatch: firecrawl gets a real call; other tools remain Phase-1 stubs. ──
  let resultPayload: unknown;
  let outcome: Record<string, unknown>;
  let costUsd = 0;
  let callOk = true;
  let blockedReason: string | undefined;

  if (isFirecrawl) {
    const fc = await executeFirecrawl(input.params);
    callOk = fc.ok;
    costUsd = fc.costUsd;
    if (fc.ok) {
      resultPayload = { firecrawl: true, action: fc.action, data: fc.result };
    } else {
      blockedReason = fc.error;
    }
    // Cost tracking: agent_id, query/params, cost (credits + usd), timestamp (created_at default).
    outcome = {
      firecrawl: true,
      action: fc.action,
      ok: fc.ok,
      cost_credits: fc.costCredits,
      cost_usd: fc.costUsd,
      query: input.params.query ?? input.params.url ?? null,
      error: fc.error ?? null,
    };
  } else {
    resultPayload = {
      stub: true,
      phase: 1,
      message: 'Phase 1: constitutional gate passed. Real call in Sprint 5 (Cerebras).',
    };
    outcome = { stub: true, phase: 1 };
  }

  const latencyMs = Date.now() - start;

  // Log tool usage for bilateral learning feedback + cost tracking.
  await db.from('trinity_tool_usage').insert({
    agent_id: input.agentId,
    tool_name: input.toolName,
    mcp_call_params: input.params,
    constitutional_compliance_score: reportedComplianceScore,
    eas_attestation_id: audit.easAttestationId,
    latency_ms: latencyMs,
    outcome,
  });

  // Only count successful real calls toward usage_count.
  if (callOk) {
    await db.from('repid_mcp_tools')
      .update({
        usage_count: (tool.usage_count ?? 0) + 1,
        last_used: new Date().toISOString(),
      })
      .eq('tool_name', input.toolName);
  }

  if (isFirecrawl && !callOk) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: audit.easAttestationId,
      complianceScore: reportedComplianceScore,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs,
      costUsd,
      blockedReason,
    };
  }

  return {
    allowed: true,
    toolName: input.toolName,
    constitutionalCue: tool.constitutional_cue,
    easAttestationId: audit.easAttestationId,
    complianceScore: reportedComplianceScore,
    requiresConservatorApproval: false,
    repidBonusEligible: tool.repid_bonus,
    latencyMs,
    costUsd,
    result: resultPayload,
  };
}
