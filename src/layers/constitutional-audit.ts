import { db } from '../db';

// ─────────────────────────────────────────────────────────────────────────────
// NON-LOAD-BEARING / NOT-YET-REAL (RULE-4 honesty gate — 2026-07-05)
//
// This module is a Sprint-3 CONTRACT SURFACE, not a working scorer. The three
// core primitives below are stubs:
//   • lasso_selectRelevantRules — returns ALL rules (no LASSO selection)
//   • anfis_scoreCompliance      — returns a hardcoded 1.0 (no ANFIS scoring)
//   • runMirrorTest              — returns true unconditionally (no VERITAS)
// Because anfis_scoreCompliance always returns 1.0, the "constitutional
// compliance score" is a fake pass, not a measurement. Shipping it as if it
// were real would be a false claim.
//
// GATE: `CONSTITUTIONAL_AUDIT_ENABLED` (default FALSE). While disabled, the
// audit MUST NOT influence any score-bearing decision (RepID delta, challenge
// verdict, MCP tool gating). Callers check `result.enabled` and route around the
// stub output when it is false. Do NOT delete the stub — it is the interface the
// real Sprint-3 implementation will fill. When the real LASSO/ANFIS/mirror land,
// flip the flag on and remove these guards at the call sites.
// ─────────────────────────────────────────────────────────────────────────────
export const CONSTITUTIONAL_AUDIT_ENABLED =
  process.env.CONSTITUTIONAL_AUDIT_ENABLED === 'true';

export interface ConstitutionalAuditInput {
  agentId: string;
  actionType: string;
  actionMetadata: Record<string, unknown>;
  challengerId?: string;
  certainty?: number;
}

export interface ConstitutionalAuditResult {
  // enabled=false means this result is a NON-LOAD-BEARING stub: complianceScore
  // is a hardcoded placeholder, NOT a measurement. Callers must not let a
  // disabled result influence any score-bearing decision.
  enabled: boolean;
  passed: boolean;
  complianceScore: number;       // 0.0 – 1.0 (ANFIS output when live; placeholder while enabled=false)
  rulesChecked: string[];        // LASSO-selected rule IDs
  violatedRule?: string;
  halMode: 1|2|3|4|5|6|7;
  // EAS attestation via ERC-8004 ValidationRegistry
  // Schema: 'constitutional-compliance-v1'
  // Fields: { ruleReference, complianceScore, evidenceMerkleRoot, mirrorTestPassed }
  // Revocable upon new evidence
  easAttestationId: string;
  easSchema: string;
  mirrorTestPassed: boolean;
  processingMs: number;
}

const LASSO_MAX_FEATURES = 512;
const LASSO_ITERATIONS = 8;
const LASSO_LAMBDA = 0.08;

function featureTokens(value: string): string[] {
  const unigrams = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1);
  const stem = (token: string): string => {
    let result = token;
    if (result.length > 4 && result.endsWith('ies')) result = `${result.slice(0, -3)}y`;
    else if (result.length > 3 && result.endsWith('s')) result = result.slice(0, -1);
    if (result.length > 5 && result.endsWith('ing')) result = result.slice(0, -3);
    else if (result.length > 4 && result.endsWith('ed')) result = result.slice(0, -2);
    if (result.length > 6 && result.endsWith('tion')) result = `${result.slice(0, -4)}t`;
    else if (result.length > 4 && result.endsWith('e')) result = result.slice(0, -1);
    return result;
  };
  const stems = unigrams.map(stem);
  const bigrams = stems.slice(0, -1).map((token, i) => `${token}:${stems[i + 1]}`);
  return [...new Set([...unigrams, ...stems, ...bigrams])];
}

function ruleText(ruleId: string, value: unknown): string {
  if (typeof value === 'string') return `${ruleId} ${value}`;
  try { return `${ruleId} ${JSON.stringify(value)}`; }
  catch { return `${ruleId} ${String(value)}`; }
}

function softThreshold(value: number, lambda: number): number {
  if (value > lambda) return value - lambda;
  if (value < -lambda) return value + lambda;
  return 0;
}

/**
 * Select constitutional rules with a small L1-regularised linear model.
 *
 * Rule token vectors are the predictors and the action token vector is the
 * response. Fixed-size coordinate descent solves
 *   1/2 ||action - rules * beta||^2 + lambda ||beta||_1
 * and therefore drives irrelevant rule coefficients exactly to zero. The
 * fixed feature/iteration caps keep the selector linear in the rule count.
 */
export function selectRelevantRulesLasso(
  rules: Record<string, unknown>, actionType: string
): string[] {
  const entries = Object.entries(rules);
  if (entries.length <= 3) return entries.map(([id]) => id);

  const actionTokens = featureTokens(actionType);
  const ruleTokens = entries.map(([id, value]) => featureTokens(ruleText(id, value)));
  const vocabulary = new Map<string, number>();
  for (const token of [...actionTokens, ...ruleTokens.flat()]) {
    if (!vocabulary.has(token) && vocabulary.size < LASSO_MAX_FEATURES) {
      vocabulary.set(token, vocabulary.size);
    }
  }

  const vectorize = (tokens: string[]): Float64Array => {
    const vector = new Float64Array(vocabulary.size);
    for (const token of tokens) {
      const index = vocabulary.get(token);
      if (index !== undefined) {
        vector[index] = (vector[index] ?? 0) + (token.includes(':') ? 1.5 : 1);
      }
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm;
    }
    return vector;
  };

  const response = vectorize(actionTokens);
  const predictors = ruleTokens.map(vectorize);
  const coefficients = new Float64Array(entries.length);
  const residual = Float64Array.from(response);
  const correlations = predictors.map(predictor => {
    let dot = 0;
    for (let k = 0; k < predictor.length; k++) {
      dot += (predictor[k] ?? 0) * (response[k] ?? 0);
    }
    return dot;
  });

  for (let iteration = 0; iteration < LASSO_ITERATIONS; iteration++) {
    for (let j = 0; j < predictors.length; j++) {
      const predictor = predictors[j]!;
      const previous = coefficients[j] ?? 0;
      let rho = 0;
      for (let k = 0; k < predictor.length; k++) {
        const x = predictor[k] ?? 0;
        rho += x * ((residual[k] ?? 0) + x * previous);
      }
      const next = softThreshold(rho, LASSO_LAMBDA);
      const delta = next - previous;
      if (delta !== 0) {
        coefficients[j] = next;
        for (let k = 0; k < predictor.length; k++) {
          residual[k] = (residual[k] ?? 0) - (predictor[k] ?? 0) * delta;
        }
      }
    }
  }

  const targetCount = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(entries.length))));
  return entries
    .map(([id], index) => ({
      id,
      index,
      coefficient: Math.abs(coefficients[index] ?? 0),
      correlation: correlations[index] ?? 0,
    }))
    .sort((a, b) =>
      b.coefficient - a.coefficient ||
      b.correlation - a.correlation ||
      a.index - b.index
    )
    .slice(0, targetCount)
    .map(item => item.id);
}

// LASSO sparse rule selection: fetch the constitution once, then run the
// bounded pure selector above. Database latency is outside the model itself.
async function lasso_selectRelevantRules(
  agentId: string, actionType: string
): Promise<string[]> {
  try {
    const { data: agent } = await db.from('repid_agents')
      .select('constitution').eq('id', agentId).single();
    if (!agent?.constitution?.rules) return [];
    return selectRelevantRulesLasso(agent.constitution.rules, actionType);
  } catch { return []; }
}

// ANFIS fuzzy compliance scoring stub
// Real: fuzzy membership functions on rule-action alignment, ~5ms
// Stub: returns 1.0 (full compliance) — Sprint 3
function anfis_scoreCompliance(
  _rules: string[], _actionMetadata: Record<string, unknown>
): number { return 1.0; }

// Mirror test stub — Sprint 3 wires VERITAS
function runMirrorTest(_result: Partial<ConstitutionalAuditResult>): boolean {
  return true;
}

// Generate EAS attestation stub
// Real Sprint 3: posts to ERC-8004 ValidationRegistry on Base Sepolia
// using EAS SchemaRegistry + Attestation contracts
// Schema: 'constitutional-compliance-v1'
// Contains: { ruleReference, complianceScore, evidenceMerkleRoot, mirrorTestPassed }
function generateEASAttestationStub(agentId: string): string {
  return `eas-stub-${Date.now()}-${agentId.slice(0, 8)}`;
}

export async function auditConstitutionalCompliance(
  input: ConstitutionalAuditInput
): Promise<ConstitutionalAuditResult> {
  const startMs = Date.now();

  // GATE (RULE-4): while CONSTITUTIONAL_AUDIT_ENABLED is false, return a
  // transparent non-authoritative result. `passed: true` keeps the pipeline a
  // clean no-op (nothing is newly vetoed), but `enabled: false` tells every
  // caller NOT to treat complianceScore as a real measurement. The 1.0 here is
  // a neutral identity placeholder, kept only so downstream shapes stay valid —
  // callers are responsible for not multiplying/branching on it when disabled.
  if (!CONSTITUTIONAL_AUDIT_ENABLED) {
    return {
      enabled: false,
      passed: true,
      complianceScore: 1.0, // placeholder ONLY — not a measurement (enabled=false)
      rulesChecked: [],
      halMode: 1,
      easAttestationId: '',
      easSchema: '',
      mirrorTestPassed: true,
      processingMs: Date.now() - startMs,
    };
  }

  // Step 1 — LASSO sparse rule selection (~2ms when live)
  const rulesChecked = await lasso_selectRelevantRules(
    input.agentId, input.actionType
  );

  // Step 2 — ANFIS fuzzy scoring (~5ms when live)
  const complianceScore = anfis_scoreCompliance(rulesChecked, input.actionMetadata);

  // Step 3 — Threshold gate (same thresholds as HAL veto)
  // > 0.85 → PASS (Mode 1 VERIFY)
  // 0.48–0.85 → gray zone (Mode 5 MEDIATE, future HITL)
  // < 0.48 → BLOCK (Mode 6 PROTECT — constitutional veto)
  const passed = complianceScore > 0.48;

  // Step 4 — Mirror test (ideological symmetry — VERITAS in Sprint 3)
  const mirrorTestPassed = runMirrorTest({ complianceScore, passed });

  // Step 5 — EAS attestation via ERC-8004 ValidationRegistry (stub)
  const easAttestationId = generateEASAttestationStub(input.agentId);

  // Step 6 — HAL mode assignment
  let halMode: ConstitutionalAuditResult['halMode'];
  if (!mirrorTestPassed) halMode = 7;
  else if (complianceScore > 0.85) halMode = 1;
  else if (complianceScore > 0.70) halMode = 2;
  else if (complianceScore > 0.48) halMode = 5;
  else halMode = 6;

  return {
    enabled: true,
    passed,
    complianceScore,
    rulesChecked,
    halMode,
    easAttestationId,
    easSchema: 'constitutional-compliance-v1',
    mirrorTestPassed,
    processingMs: Date.now() - startMs,
  };
}

// Adversarial challenge — agent/human challenges another agent's behavior
// Full LASSO + ANFIS + HAL mediation pipeline in Sprint 3
export async function fileConstitutionalChallenge(params: {
  challengerId: string;
  targetAgentId: string;
  allegedRuleReference: string;
  evidenceEventIds: string[];
  certainty: number;
}): Promise<{
  challengeId: string;
  status: 'ACCEPTED'|'REJECTED'|'PENDING_HAL_MEDIATION';
  message: string;
}> {
  return {
    challengeId: `challenge-${Date.now()}`,
    status: 'PENDING_HAL_MEDIATION',
    message: 'Constitutional challenge filed. LASSO+ANFIS+HAL mediation pipeline live in Sprint 3.',
  };
}
