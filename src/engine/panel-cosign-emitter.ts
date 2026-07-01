/**
 * panel-cosign-emitter.ts — F4 (XC_PURPOSE_GATE_REDTEAM 2026-06-30): wire the BFT panel verdict → RepID.
 * Branch feat/cc-cc-panel-cosign-emitter. BLOCKED from prod until Claude+XC re-verify + Sean GO.
 *
 * A SHA-bound verification panel (verification_panel / code_review_sha_bound) produces one verdict per panelist
 * against an artifact commit. This turns that verdict into RepID events via updateRepId:
 *   - panelist aligned with the majority  -> HANDOFF_COSIGN_VERIFIED  (+10)
 *   - panelist diverged from the majority  -> PEER_VERIFY_WRONG_CALL   (-5)   [unless exempt]
 * EXEMPT: a panelist that flagged its own uncertainty (self_flagged_uncertain) OR reported confidence < 0.6 is
 * NOT slashed for diverging — honest "I'm not sure" must not be punished (Squad B §7.4; XC F4 requirement).
 *
 * GATE PARITY: all three deltas are gated behind DOGFOOD_REPID_FROM_COSIGN inside updateRepId
 * (isCosignGatedEvent) — nothing here can move a LIVE score while the flag is OFF. Closes XC's
 * "PEER_VERIFY_WRONG_CALL -5 could apply live while +10 award stays gated" asymmetric-dogfood hole.
 *
 * NO MOCK: PanelVerdict mirrors the real coordinator / agent_handoffs shape (artifact SHA + per-agent calls).
 * FAIL-LOUD: malformed verdicts throw (RULE-11) — a bad panel must never silently score nothing.
 */
import { updateRepId, RepIdUpdateResult } from './repid-update';

export const CONFIDENCE_EXEMPT_THRESHOLD = 0.6;

export interface PanelistCall {
  agent_id: string;                 // repid_agents.id (uuid) of the panelist
  call: string;                     // this panelist's verdict token (e.g. 'PASS' | 'FAIL' | a label)
  confidence?: number;              // 0..1 self-reported; < 0.6 exempts a diverging panelist from the slash
  self_flagged_uncertain?: boolean; // explicit self-flag → exempt from the slash on divergence
}

export interface PanelVerdict {
  artifact_commit: string;          // the commit SHA the review is bound to (provenance)
  panelists: PanelistCall[];        // >= 1 SHA-bound calls
  majority?: string;                // optional; if omitted it is computed from the calls (validated if provided)
}

export type EmittedOutcome =
  | { agent_id: string; event: 'HANDOFF_COSIGN_VERIFIED'; result: RepIdUpdateResult }
  | { agent_id: string; event: 'PEER_VERIFY_WRONG_CALL'; result: RepIdUpdateResult }
  | { agent_id: string; event: 'EXEMPT'; reason: string };

export interface PanelEmitResult {
  artifact_commit: string;
  majority: string;
  emitted: EmittedOutcome[];
}

/** Strict majority (mode) of the calls. Ties → 'contested' (no strict majority → no divergence baseline). */
export function computeMajority(calls: PanelistCall[]): string {
  const tally = new Map<string, number>();
  for (const c of calls) tally.set(c.call, (tally.get(c.call) ?? 0) + 1);
  let top = '', topN = -1, tie = false;
  for (const [call, n] of tally) {
    if (n > topN) { top = call; topN = n; tie = false; }
    else if (n === topN) { tie = true; }
  }
  return tie ? 'contested' : top;
}

/** A diverging panelist is exempt from the slash if it flagged uncertainty or reported low confidence. */
export function exemptReason(p: PanelistCall): string | null {
  if (p.self_flagged_uncertain === true) return 'self_flagged_uncertain';
  if (typeof p.confidence === 'number' && p.confidence < CONFIDENCE_EXEMPT_THRESHOLD) {
    return `confidence ${p.confidence} < ${CONFIDENCE_EXEMPT_THRESHOLD}`;
  }
  return null;
}

export async function emitPanelVerdict(verdict: PanelVerdict): Promise<PanelEmitResult> {
  // FAIL-LOUD validation (RULE-11).
  if (!verdict || typeof verdict !== 'object') throw new Error('emitPanelVerdict: verdict missing');
  if (!verdict.artifact_commit || !/^[0-9a-f]{7,64}$/i.test(verdict.artifact_commit)) {
    throw new Error(`emitPanelVerdict: artifact_commit is not a commit SHA: ${verdict.artifact_commit}`);
  }
  if (!Array.isArray(verdict.panelists) || verdict.panelists.length === 0) {
    throw new Error('emitPanelVerdict: no panelists');
  }
  for (const p of verdict.panelists) {
    if (!p || !p.agent_id) throw new Error('emitPanelVerdict: panelist missing agent_id');
    if (typeof p.call !== 'string' || p.call === '') throw new Error(`emitPanelVerdict: panelist ${p.agent_id} missing call`);
    if (p.confidence != null && (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1)) {
      throw new Error(`emitPanelVerdict: panelist ${p.agent_id} bad confidence ${p.confidence}`);
    }
  }

  const computed = computeMajority(verdict.panelists);
  // If the caller supplied a majority that disagrees with the calls, fail loud — never score on a wrong premise.
  if (verdict.majority && verdict.majority !== computed) {
    throw new Error(`emitPanelVerdict: provided majority '${verdict.majority}' != computed '${computed}'`);
  }
  const majority = computed;
  if (majority === 'contested') {
    // No strict majority → no divergence baseline → emit nothing (returned explicitly, not silent).
    return { artifact_commit: verdict.artifact_commit, majority, emitted: [] };
  }

  const emitted: EmittedOutcome[] = [];
  for (const p of verdict.panelists) {
    if (p.call === majority) {
      const result = await updateRepId({ agentId: p.agent_id, eventType: 'HANDOFF_COSIGN_VERIFIED' });
      emitted.push({ agent_id: p.agent_id, event: 'HANDOFF_COSIGN_VERIFIED', result });
    } else {
      const reason = exemptReason(p);
      if (reason) { emitted.push({ agent_id: p.agent_id, event: 'EXEMPT', reason }); continue; }
      const result = await updateRepId({ agentId: p.agent_id, eventType: 'PEER_VERIFY_WRONG_CALL' });
      emitted.push({ agent_id: p.agent_id, event: 'PEER_VERIFY_WRONG_CALL', result });
    }
  }
  return { artifact_commit: verdict.artifact_commit, majority, emitted };
}
