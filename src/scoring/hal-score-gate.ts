/**
 * HAL_SCORE_GATE_MODE = off | shadow | enforce. Default off. Gap 2 of the 2026-11-16 E2E eval.
 *
 * The defect, as measured. `runScoreEvent` scores with whatever strictness getHalConfig() resolves.
 * The code default is 1, the style extractor, which cannot tell a true claim from a false one: in
 * the eval it scored "The Eiffel Tower is in Berlin" flagged, delta 0, and a true claim the same way,
 * while the live quorum vetoed the false one. Production is NOT on that path today: repid_config
 * sets HAL_STRICTNESS=2, and every HAL_SCORE_EVENT since 2026-06-04 ran the fact-check quorum
 * [MEASURED 2026-11-16, read-only]. The extractor default bites wherever that row is not read:
 * a fresh or self-hosted deploy, a local run, or HAL_CONFIG_FROM_DB=false with no env.
 *
 *   off      nothing below runs. Byte-identical to before this file existed.
 *   shadow   after each score event is written, the quorum's verdict on the same answer is
 *            recorded beside the live one in hal_score_gate_shadow, with the HAL delta each would
 *            give and a receipt id for each. The live row, delta and score never change. When the
 *            live path already IS the quorum (strictness 2, production today) no extra call is
 *            made: the live verdict is recorded as both, and the two deltas are recomputed
 *            independently, so a mismatch in that table means the shadow copy of the gate chain has
 *            drifted from the live one.
 *   enforce  REFUSED (CLAUDE_RULES r23: original + live = shadow only until Sean's GO). Runs as
 *            shadow and says so loudly at boot. There is no override variable on purpose: lifting
 *            the refusal is a code change and a review, not an env edit.
 *
 * Cost bound in shadow, per score event: 0 provider calls when the live path is the quorum or the
 * score-gate cache holds the answer (src/cache/hal-cache.ts, its own key namespace, 1h TTL);
 * otherwise ONE quorum evaluation, cost-ordered (free wave first) with the two-family early stop,
 * so at most one request per enabled provider and usually only the free wave. It runs after the
 * response path, so it adds no latency to the score write.
 */
import { db } from '../db';

export type HalScoreGateMode = 'off' | 'shadow';

function normalise(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/** The mode this process runs. `enforce` resolves to shadow (refused); anything unknown is off. */
export function halScoreGateMode(value: string | undefined = process.env.HAL_SCORE_GATE_MODE): HalScoreGateMode {
  const raw = normalise(value);
  return raw === 'shadow' || raw === 'enforce' ? 'shadow' : 'off';
}

/** Once, at boot. Loud when enforce was asked for, or when the value is not one we know. */
export function announceHalScoreGateMode(value: string | undefined = process.env.HAL_SCORE_GATE_MODE): void {
  const raw = normalise(value);
  if (raw === 'enforce') {
    console.error(
      "[hal-score-gate] HAL_SCORE_GATE_MODE=enforce REFUSED: the quorum may not move RepID through " +
        "this switch until Sean's GO (CLAUDE_RULES r23). Running as 'shadow': verdicts are recorded, no score moves.",
    );
    return;
  }
  if (raw !== '' && raw !== 'off' && raw !== 'shadow') {
    console.error(`[hal-score-gate] HAL_SCORE_GATE_MODE='${raw}' is not off|shadow|enforce. Resolved to 'off'.`);
    return;
  }
  console.log(`[hal-score-gate] HAL_SCORE_GATE_MODE resolved to '${halScoreGateMode(value)}'`);
}

/** One row of hal_score_gate_shadow (supabase/migrations/20261116180000_hal_score_gate_shadow.sql). */
export interface HalScoreGateShadowRow {
  score_event_id: number;
  agent_id: string;
  mode: 'shadow';
  live_strictness: number;
  live_hal_mode: string | null;
  live_decision: string;
  live_hal_score: number;
  live_hal_delta: number;
  live_receipt_id: string;
  quorum_source: 'live' | 'cache' | 'fresh' | 'not_checked';
  quorum_hal_mode: string | null;
  quorum_raw_decision: string | null;
  quorum_decision: string | null;
  quorum_hal_score: number | null;
  quorum_met: boolean;
  quorum_families: string[];
  quorum_hal_delta: number | null;
  quorum_receipt_id: string | null;
  quorum_latency_ms: number | null;
  not_checked_reason: string | null;
}

let missingTableReported = false;

/** Never throws. A missing table (migration not applied) is reported loudly once, then quietly skipped. */
export async function writeHalScoreGateShadow(row: HalScoreGateShadowRow): Promise<boolean> {
  try {
    const { error } = await db.from('hal_score_gate_shadow').insert(row);
    if (!error) return true;
    const missing = error.code === '42P01' || error.code === 'PGRST205';
    if (!missing || !missingTableReported) {
      console.error(
        `[hal-score-gate] shadow row NOT written for score_event=${row.score_event_id}: ${error.message}` +
          (missing ? ' (table missing: apply supabase/migrations/20261116180000_hal_score_gate_shadow.sql)' : ''),
      );
    }
    if (missing) missingTableReported = true;
    return false;
  } catch (e: unknown) {
    console.error(`[hal-score-gate] shadow row write threw for score_event=${row.score_event_id}:`, e instanceof Error ? e.message : e);
    return false;
  }
}
