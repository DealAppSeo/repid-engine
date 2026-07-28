import { db } from '../db';

/**
 * Write-churn / noise fix (2026-07-02): `trinity_agent_logs` had grown to ~1.8M rows because
 * several hot paths (notably auth.ts `api_auth_attempt`, fired on EVERY authenticated request,
 * and the always-on ZKP stub) insert a row unconditionally. This is a write-only monitoring log
 * with no reader in this codebase, so the low-value, high-frequency events are pure noise.
 *
 * This helper adds two env-configurable gates in front of the insert:
 *
 *   AGENT_LOG_MIN_LEVEL  (default 'info')   — drop events below this severity.
 *                                             order: debug < info < warn < error
 *   AGENT_LOG_SAMPLE     (default '1')      — probability [0..1] that an 'info'/'debug' event is
 *                                             kept. e.g. 0.05 keeps ~5% of routine events.
 *                                             warn/error are ALWAYS kept regardless of sample.
 *
 * Defaults are safe (min-level=info, sample=1 → identical behavior to today). Ops throttles by
 * setting e.g. AGENT_LOG_SAMPLE=0.02 in Railway. The gate NEVER throws — logging must not break
 * the request path.
 */

export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<AgentLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function parseMinLevel(): AgentLogLevel {
  const raw = (process.env.AGENT_LOG_MIN_LEVEL || 'info').toLowerCase();
  return (raw in LEVEL_ORDER ? raw : 'info') as AgentLogLevel;
}

function parseSampleRate(): number {
  const raw = Number(process.env.AGENT_LOG_SAMPLE ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Pure decision function (testable): should an event at `level` be written, given the configured
 * min-level, sample rate, and a caller-supplied roll in [0,1)? warn/error bypass sampling.
 */
export function shouldLogEvent(
  level: AgentLogLevel,
  minLevel: AgentLogLevel,
  sampleRate: number,
  roll: number,
): boolean {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return false;
  if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) return true; // never sample-drop warn/error
  return roll < sampleRate;
}

/**
 * The row contract lives in `agent-log-row.ts` — dependency-free so that pure modules can use it
 * without pulling in the `db` singleton (which throws at import without credentials). Re-exported
 * here so existing importers of `agent-log` keep working.
 */
export { buildAgentLogRow } from './agent-log-row';
export type { AgentLogRow } from './agent-log-row';
import { buildAgentLogRow as buildRow } from './agent-log-row';
import type { AgentLogRow } from './agent-log-row';

/**
 * Gated best-effort insert into trinity_agent_logs. Returns true if the row was written (or
 * attempted), false if it was gated out. Never throws.
 */
export async function logAgentEvent(
  row: AgentLogRow,
  level: AgentLogLevel = 'info',
): Promise<boolean> {
  try {
    if (!shouldLogEvent(level, parseMinLevel(), parseSampleRate(), Math.random())) {
      return false;
    }
    const { error } = await db.from('trinity_agent_logs').insert(buildRow(row));
    if (error) console.error(error);
    return true;
  } catch (err) {
    // Monitoring write must never break the caller.
    return false;
  }
}
