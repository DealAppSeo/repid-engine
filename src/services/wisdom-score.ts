/**
 * Wisdom score — calibration via the Pythagorean Comma.
 *
 * Computed over the trailing 50 wisdom-history rows for an agent:
 *   meanClaimedConfidence = mean(claimed_confidence / 10000)
 *   actualAccuracy        = correct_count / total_count
 *   calibrationError      = abs(meanClaimedConfidence - actualAccuracy)
 *
 * If calibrationError > COMMA_THRESHOLD (0.0136433):
 *   newWisdom = floor(currentWisdom / PYTHAGOREAN_COMMA)
 * Else (well calibrated):
 *   newWisdom = floor(currentWisdom * 1.001)        // small reward
 *
 * Bounds: [W_FLOOR=100, W_CEILING=2000]. Less than 5 history rows
 * means no adjustment (returns the current value untouched).
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

export const PYTHAGOREAN_COMMA = 1.0136433;
export const COMMA_THRESHOLD = 0.0136433;
export const W_FLOOR = 100;
export const W_CEILING = 2000;
export const MIN_HISTORY = 5;
export const TRAILING_WINDOW = 50;

export interface WisdomUpdateResult {
  agent_id: string;
  old_wisdom: number;
  new_wisdom: number;
  calibration_error: number | null;
  comma_applied: boolean;
  history_count: number;
}

export async function getCurrentWisdom(agentId: string): Promise<number> {
  const { data } = await db
    .from('repid_agents')
    .select('wisdom_score')
    .eq('id', agentId)
    .maybeSingle();
  return Number(data?.wisdom_score ?? 1000);
}

export async function updateWisdomScore(
  agentId: string,
  claimedConfidence: number,
  wasCorrect: boolean,
): Promise<WisdomUpdateResult> {
  // Record the data point first so subsequent queries see it.
  await db.from('agent_wisdom_history').insert({
    agent_id: agentId,
    claimed_confidence: claimedConfidence,
    actual_outcome: wasCorrect ? 1 : 0,
    calibration_delta: null,
  });

  const { data: history } = await db
    .from('agent_wisdom_history')
    .select('claimed_confidence, actual_outcome')
    .eq('agent_id', agentId)
    .order('computed_at', { ascending: false })
    .limit(TRAILING_WINDOW);

  const current = await getCurrentWisdom(agentId);
  const list = history ?? [];

  if (list.length < MIN_HISTORY) {
    return {
      agent_id: agentId,
      old_wisdom: current,
      new_wisdom: current,
      calibration_error: null,
      comma_applied: false,
      history_count: list.length,
    };
  }

  const meanClaimed = list.reduce((s, h) => s + Number(h.claimed_confidence ?? 0), 0) / list.length / 10000;
  const accuracy = list.filter(h => Number(h.actual_outcome) === 1).length / list.length;
  const calibrationError = Math.abs(meanClaimed - accuracy);

  let newWisdom: number;
  let commaApplied = false;
  if (calibrationError > COMMA_THRESHOLD) {
    newWisdom = Math.max(W_FLOOR, Math.floor(current / PYTHAGOREAN_COMMA));
    commaApplied = true;
  } else {
    newWisdom = Math.min(W_CEILING, Math.floor(current * 1.001));
  }

  await db.from('repid_agents').update({
    wisdom_score: newWisdom,
    wisdom_history_count: list.length,
  }).eq('id', agentId);

  await emitAuditEvent({
    event_type: 'wisdom_update',
    source_table: 'repid_agents',
    source_id: agentId,
    payload: {
      agent_id: agentId,
      old: current,
      new: newWisdom,
      calibration_error: calibrationError,
      comma_applied: commaApplied,
      history_count: list.length,
    },
  });

  return {
    agent_id: agentId,
    old_wisdom: current,
    new_wisdom: newWisdom,
    calibration_error: calibrationError,
    comma_applied: commaApplied,
    history_count: list.length,
  };
}

// Pure helper exposed for tests.
export function computeNewWisdom(current: number, calibrationError: number): { newWisdom: number; commaApplied: boolean } {
  if (calibrationError > COMMA_THRESHOLD) {
    return { newWisdom: Math.max(W_FLOOR, Math.floor(current / PYTHAGOREAN_COMMA)), commaApplied: true };
  }
  return { newWisdom: Math.min(W_CEILING, Math.floor(current * 1.001)), commaApplied: false };
}
