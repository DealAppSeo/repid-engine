import { db } from '../db';

// djb2 hash — never store raw prompt text. Returns "prompt_<hex>".
export function hashPrompt(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0; // force uint32
  }
  return `prompt_${hash.toString(16)}`;
}

export interface HalProductionEvent {
  agentId?: string;
  agentRepid?: number;
  agentDomain?: string;
  promptHash: string;
  certaintyAtClaim?: number;
  halVerdict: string;
  halMode: number;
  halComplianceScore?: number;
  pcvDissonance?: number;
  layersActive: Record<string, boolean>;
  layerFirstFlagged?: string;
  sbfaScore?: number;
  sbfaLatencyMs?: number;
  bftConsensusPct?: number;
  bftLatencyMs?: number;
  sltUncertainty?: number;
  sltLatencyMs?: number;
  repidWeight?: number;
  repidLatencyMs?: number;
  wsceCoherence?: number;
  wsceLatencyMs?: number;
  gnnsrContradictions?: number;
  gnnsrLatencyMs?: number;
  anfisAdjustment?: number;
  anfisLatencyMs?: number;
  pcvVetoed?: boolean;
  pcvLatencyMs?: number;
  totalLatencyMs?: number;
  isHallucination?: boolean;
  hallucinationType?: string;
  hallucinationSeverity?: number;
  wasCaught?: boolean;
  falsePositive?: boolean;
  easAttestationId?: string;
  hashkeyTxHash?: string;
}

// Non-blocking insert into hal_production_events. Never throws.
export async function logHalProductionEvent(
  event: HalProductionEvent
): Promise<void> {
  try {
    const row: Record<string, unknown> = {
      agent_id: event.agentId ?? null,
      agent_repid: event.agentRepid ?? null,
      agent_domain: event.agentDomain ?? null,
      prompt_hash: event.promptHash,
      certainty_at_claim: event.certaintyAtClaim ?? null,
      hal_verdict: event.halVerdict,
      hal_mode: event.halMode,
      hal_compliance_score: event.halComplianceScore ?? null,
      pcv_dissonance: event.pcvDissonance ?? null,
      layers_active: event.layersActive,
      layer_first_flagged: event.layerFirstFlagged ?? null,
      sbfa_score: event.sbfaScore ?? null,
      sbfa_latency_ms: event.sbfaLatencyMs ?? null,
      bft_consensus_pct: event.bftConsensusPct ?? null,
      bft_latency_ms: event.bftLatencyMs ?? null,
      slt_uncertainty: event.sltUncertainty ?? null,
      slt_latency_ms: event.sltLatencyMs ?? null,
      repid_weight: event.repidWeight ?? null,
      repid_latency_ms: event.repidLatencyMs ?? null,
      wsce_coherence: event.wsceCoherence ?? null,
      wsce_latency_ms: event.wsceLatencyMs ?? null,
      gnnsr_contradictions: event.gnnsrContradictions ?? null,
      gnnsr_latency_ms: event.gnnsrLatencyMs ?? null,
      anfis_adjustment: event.anfisAdjustment ?? null,
      anfis_latency_ms: event.anfisLatencyMs ?? null,
      pcv_vetoed: event.pcvVetoed ?? null,
      pcv_latency_ms: event.pcvLatencyMs ?? null,
      total_latency_ms: event.totalLatencyMs ?? null,
      is_hallucination: event.isHallucination ?? null,
      hallucination_type: event.hallucinationType ?? null,
      hallucination_severity: event.hallucinationSeverity ?? null,
      was_caught: event.wasCaught ?? null,
      false_positive: event.falsePositive ?? null,
      eas_attestation_id: event.easAttestationId ?? null,
      hashkey_tx_hash: event.hashkeyTxHash ?? null,
    };
    const { error } = await db.from('hal_production_events').insert(row);
    if (error) {
      console.error('[hal-logger] insert failed:', error.message);
    }
  } catch (err: any) {
    console.error('[hal-logger] unexpected error:', err?.message ?? err);
  }
}
