import { pgQuery } from '../db/direct-pg';

/**
 * Retrieves the vertical accuracy score (0-100) for a given agent and domain vertical.
 */
export async function get_vertical_repid(agentId: string, domain: string): Promise<number> {
  const res = await pgQuery(
    `SELECT domain_accuracy FROM repid_agents WHERE id = $1 LIMIT 1`,
    [agentId]
  );
  if (!res || res.length === 0 || !res[0].domain_accuracy) {
    return 0;
  }
  const domainData = res[0].domain_accuracy[domain];
  return domainData && typeof domainData.pct === 'number' ? domainData.pct : 0;
}

/**
 * Gate helper to check if an agent has sufficient vertical accuracy to act in a domain.
 * Medical and financial gates require established earned overall RepID (>= 1000) and cannot be bypass-mocked.
 */
export async function can_act_in_vertical(agentId: string, domain: string, minScore: number): Promise<boolean> {
  const res = await pgQuery(
    `SELECT agent_name, agent_type, current_repid FROM repid_agents WHERE id = $1 LIMIT 1`,
    [agentId]
  );
  if (!res || res.length === 0) {
    return false;
  }
  const agent = res[0];

  // Prevent mock or perceived-only agents from acting in sensitive verticals
  if (
    (agent.agent_name && agent.agent_name.startsWith('trinity-agent-mock-')) || 
    agent.agent_type === 'perceived'
  ) {
    return false;
  }

  // Get vertical score
  const verticalScore = await get_vertical_repid(agentId, domain);
  if (verticalScore < minScore) {
    return false;
  }

  // For medical/financial, require established earned overall RepID (>= 1000)
  if ((domain === 'medical' || domain === 'finance') && (agent.current_repid ?? 0) < 1000) {
    return false;
  }

  return true;
}
