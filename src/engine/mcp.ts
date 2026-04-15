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
  complianceScore: number;
  requiresConservatorApproval: boolean;
  repidBonusEligible: number;
  latencyMs: number;
  result?: unknown;
  blockedReason?: string;
}

// Uses repid_mcp_tools (agent-facing tool registry) — separate from
// trinity_mcp_registry, which is the Trinity Symphony MCP server discovery table.
export async function callMCPWithGuardrails(
  input: MCPCallInput
): Promise<MCPCallResult> {
  const start = Date.now();

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

  const audit = await auditConstitutionalCompliance({
    agentId: input.agentId,
    actionType: `MCP_CALL:${input.toolName}`,
    actionMetadata: { toolName: input.toolName, params: input.params },
  });

  const latencyMs = Date.now() - start;

  // Log tool usage for bilateral learning feedback
  await db.from('trinity_tool_usage').insert({
    agent_id: input.agentId,
    tool_name: input.toolName,
    mcp_call_params: input.params,
    constitutional_compliance_score: audit.complianceScore,
    eas_attestation_id: audit.easAttestationId,
    latency_ms: latencyMs,
    outcome: { stub: true, phase: 1 },
  });

  if (tool.requires_conservator_approval) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: audit.easAttestationId,
      complianceScore: audit.complianceScore,
      requiresConservatorApproval: true,
      repidBonusEligible: tool.repid_bonus,
      latencyMs,
      blockedReason: 'Conservator approval required — notify Sean before proceeding',
    };
  }

  if (!audit.passed) {
    return {
      allowed: false,
      toolName: input.toolName,
      constitutionalCue: tool.constitutional_cue,
      easAttestationId: audit.easAttestationId,
      complianceScore: audit.complianceScore,
      requiresConservatorApproval: false,
      repidBonusEligible: 0,
      latencyMs,
      blockedReason: `Constitutional compliance failed: ${audit.complianceScore}`,
    };
  }

  await db.from('repid_mcp_tools')
    .update({
      usage_count: (tool.usage_count ?? 0) + 1,
      last_used: new Date().toISOString(),
    })
    .eq('tool_name', input.toolName);

  return {
    allowed: true,
    toolName: input.toolName,
    constitutionalCue: tool.constitutional_cue,
    easAttestationId: audit.easAttestationId,
    complianceScore: audit.complianceScore,
    requiresConservatorApproval: false,
    repidBonusEligible: tool.repid_bonus,
    latencyMs,
    result: {
      stub: true,
      phase: 1,
      message: 'Phase 1: constitutional gate passed. Real call in Sprint 5 (Cerebras).',
    },
  };
}
