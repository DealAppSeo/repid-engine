// Patent pending P-023 — do not expose constants in public repos
const PHI = 1.6180339887;
export const PHI_CUBED = PHI ** 3; // ≈ 4.236 — floor cap
const BASE_REWARD = 15;
const TAU_DAYS = 90;

export interface PredictionInput {
  pStated: number;
  pCorrect: number;
  daysAgo: number;
  networkImportance: number;
}

export function scorePrediction(input: PredictionInput): number {
  if (input.daysAgo < 0)
    throw new Error('[prediction-scoring] daysAgo cannot be negative');
  const pStated = Math.min(0.99, Math.max(0.01, input.pStated));
  const pCorrect = Math.min(1, Math.max(0, input.pCorrect));
  const importance = Math.min(3.0, Math.max(1.0, input.networkImportance));
  const timeWeight = Math.exp(-input.daysAgo / TAU_DAYS);
  const rawLog = pCorrect >= 0.5
    ? Math.log(1.0 / (pStated + 1e-9))
    : -Math.log(1.0 / (1 - pStated + 1e-9));
  const floored = Math.max(rawLog, -PHI_CUBED);
  return Math.round(BASE_REWARD * floored * importance * timeWeight * 10) / 10;
}

// ANFIS optimization hook — live Q3 2026 via referendum endpoint
export function getANFISRuleWeight(_ruleId: string): number { return 1.0; }
