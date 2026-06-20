/**
 * Public-surface filters — exclude adversarial mock agents from all TrustShell reads.
 * SCHEMA-FIRST: agent_id column on repid_agents (verified 2026-06-19).
 */

/** Canonical 12 Trinity agents (minted on-chain; metadata activation target). */
export const TRINITY_12_AGENT_NAMES = [
  'trinity-mel',
  'trinity-sophia',
  'trinity-torch',
  'trinity-nexus',
  'trinity-hdm',
  'trinity-gcm',
  'trinity-apm',
  'trinity-w3c',
  'trinity-chesed',
  'trinity-shofet',
  'trinity-veritas',
  'trinity-orch',
] as const;

/** SQL fragment — append to WHERE clauses on repid_agents.agent_id */
export const MOCK_AGENT_EXCLUSION_SQL = `COALESCE(agent_id, '') NOT LIKE 'trinity-agent-mock-%'`;

/** SQL fragment — Trinity 12 only */
export const TRINITY_12_NAMES_SQL = TRINITY_12_AGENT_NAMES.map((n) => `'${n}'`).join(', ');

export function isMockAgentId(agentId: string | null | undefined): boolean {
  return !!agentId && agentId.startsWith('trinity-agent-mock-');
}

export function isTrinity12AgentName(name: string): boolean {
  return (TRINITY_12_AGENT_NAMES as readonly string[]).includes(name);
}