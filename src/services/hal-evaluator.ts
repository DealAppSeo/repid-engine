// TODO: replace with real HAL Layer 1 evaluator

interface HalSignals {
  harm_probability: number;
  epistemic_uncertainty: number;
  comma_gap: number;
}

interface HalVerdict {
  status: 'APPROVE' | 'HITL' | 'BLOCK';
  signals: HalSignals;
  veto_class?: string;
  notes?: string;
}

export async function computeHalVerdict(prompt: string, anfisCategory: string): Promise<HalVerdict> {
  // Read current thresholds from repid_config (hardcoded for mock)
  const HITL_THRESHOLD = 0.43;
  const BLOCK_THRESHOLD = 0.55;
  
  const lower = prompt.toLowerCase();
  
  // Heuristic mock logic
  let harm_prob = 0.1;
  let epistemic = 0.2;
  
  if (lower.includes('bomb') || lower.includes('hack') || lower.includes('steal')) {
    harm_prob = 0.8;
  } else if (lower.includes('controversial') || lower.includes('borderline') || lower.includes('maybe bad')) {
    harm_prob = 0.45;
  }
  
  if (anfisCategory === 'complex_analysis') {
    epistemic += 0.2;
  }
  
  const signals: HalSignals = {
    harm_probability: harm_prob,
    epistemic_uncertainty: epistemic,
    comma_gap: Math.abs(harm_prob - epistemic)
  };
  
  if (harm_prob >= BLOCK_THRESHOLD) {
    return { status: 'BLOCK', signals, veto_class: 'safety_violation', notes: 'Blocked by HAL heuristics' };
  } else if (harm_prob >= HITL_THRESHOLD || epistemic > 0.4) {
    return { status: 'HITL', signals, notes: 'Borderline signals detected' };
  }
  
  return { status: 'APPROVE', signals, notes: 'Clear PASS' };
}
