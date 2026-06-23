/**
 * Agent loop control — SSOT table `agent_controls` (enabled flag).
 * Used by Telegram /sleep /wake /status and controller surfaces.
 * Cache: Dragonfly/Redis via cache helpers (~10s TTL).
 */
import { pgQuery } from '../db/direct-pg';
import { cacheDel, cacheGet, cacheSet } from '../cache/dragonfly';

const CACHE_TTL_SEC = Number(process.env.AGENT_CONTROL_CACHE_TTL_SEC || 10);

export function toControlName(agentName: string): string {
  return String(agentName || '')
    .toLowerCase()
    .replace(/^trinity-/, '')
    .trim();
}

function cacheKey(controlName: string): string {
  return `agent_control:${controlName}`;
}

export interface AgentControlRow {
  agent_name: string;
  enabled: boolean;
  updated_by: string | null;
  reason: string | null;
  updated_at: string;
}

async function bustCache(controlName: string): Promise<void> {
  await cacheDel(cacheKey(controlName));
}

export async function isAgentEnabled(agentName: string): Promise<boolean> {
  const controlName = toControlName(agentName);
  const key = cacheKey(controlName);

  const cached = await cacheGet(key);
  if (cached === '1') return true;
  if (cached === '0') return false;

  try {
    const rows = await pgQuery<{ enabled: boolean }>(
      `SELECT enabled FROM agent_controls WHERE agent_name = $1`,
      [controlName],
      { retries: 1, label: 'agent-controls-read' }
    );
    const enabled = rows.length ? !!rows[0]!.enabled : true;
    await cacheSet(key, enabled ? '1' : '0', CACHE_TTL_SEC);
    return enabled;
  } catch (e: any) {
    console.warn(`[agent-controls] store unreachable for ${controlName}, default-off:`, e?.message ?? e);
    return false;
  }
}

export async function setAgentEnabled(
  agentName: string,
  enabled: boolean,
  updatedBy: string,
  reason?: string
): Promise<AgentControlRow> {
  const controlName = toControlName(agentName);
  if (!controlName || controlName.length > 100) {
    throw new Error('invalid agent name');
  }

  const rows = await pgQuery<AgentControlRow>(
    `INSERT INTO agent_controls (agent_name, enabled, updated_by, reason, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (agent_name) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           updated_by = EXCLUDED.updated_by,
           reason = EXCLUDED.reason,
           updated_at = now()
     RETURNING agent_name, enabled, updated_by, reason, updated_at`,
    [controlName, enabled, updatedBy, reason ?? null],
    { label: 'agent-controls-upsert' }
  );

  await bustCache(controlName);
  return rows[0]!;
}

export async function listAgentControls(): Promise<AgentControlRow[]> {
  return pgQuery<AgentControlRow>(
    `SELECT agent_name, enabled, updated_by, reason, updated_at
     FROM agent_controls
     ORDER BY agent_name`,
    [],
    { label: 'agent-controls-list' }
  );
}