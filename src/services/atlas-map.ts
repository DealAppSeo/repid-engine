/**
 * MITRE ATLAS / ATT&CK annotation of the governance rules (CC, 2026-06-25 r7 Phase 2).
 *
 * Expresses TrustRails' coverage in the standard adversarial-AI taxonomy so coverage claims are
 * reviewable (Marco / external reviewers). Each rule is mapped to:
 *   - atlasTactic    — the ATLAS tactic (category) it defends. High confidence (names are stable).
 *   - atlasTechnique — best-match ATLAS technique id(s). ⚠ VERIFY against the live atlas.mitre.org
 *                      matrix before publishing — ATLAS technique ids have changed across versions,
 *                      so these are marked [verify], not asserted as [V].
 *   - attack         — the precise MITRE ATT&CK Enterprise technique id (high confidence) for the
 *                      underlying infra action, since these rules largely govern classic infra ops
 *                      performed by an AI agent.
 *
 * Honesty note (RULE-4): atlasTechnique ids are best-effort and flagged for verification; the
 * atlasTactic + attack columns are the dependable mapping.
 */
import { type RuleId } from './consequence-classifier';
import { type SessionSignal } from './session-risk';

export interface AtlasAnnotation {
  atlasTactic: string;
  atlasTechnique: string; // [verify] vs live ATLAS matrix
  attack: string;         // MITRE ATT&CK Enterprise (precise)
  note: string;
}

/** Per consequence-classifier rule. */
export const RULE_ATLAS: Record<RuleId, AtlasAnnotation> = {
  T2_DDL: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0048 External Harms [verify]', attack: 'T1485 Data Destruction', note: 'DROP/TRUNCATE/etc destroys data' },
  T2_PROD_PROJECT: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0048 External Harms [verify]', attack: 'T1496 Resource Hijacking / T1485', note: 'targets the production project' },
  T2_PLATFORM_PROD: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0048 External Harms [verify]', attack: 'T1578 Modify Cloud Compute Infrastructure', note: 'prod platform mutation' },
  T2_PROTECTED_GIT: { atlasTactic: 'Persistence / Defense Evasion', atlasTechnique: 'AML.T0018 Manipulate AI Model (supply-chain) [verify]', attack: 'T1195 Supply Chain Compromise / T1565 Data Manipulation', note: 'push/merge to a protected branch' },
  T2_SECRET: { atlasTactic: 'Credential Access', atlasTechnique: 'AML.T0055 Unsecured Credentials [verify]', attack: 'T1552 Unsecured Credentials', note: 'secret read/rotation' },
  T2_CRITICAL_PATH: { atlasTactic: 'Credential Access / Impact', atlasTechnique: 'AML.T0055 Unsecured Credentials [verify]', attack: 'T1552.001 Credentials In Files', note: '.env / secrets/ / *.pem / *.key / migrations/' },
  T2_PROD_IDENTIFIER_IN_TEXT: { atlasTactic: 'Reconnaissance', atlasTechnique: 'AML.T0006 Active Scanning [verify]', attack: 'T1592 Gather Victim Host Information', note: 'prod identifier referenced anywhere in the action' },
  T2_HIGH_COST: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0034 Cost Harvesting [verify]', attack: 'T1496 Resource Hijacking', note: 'spend ≥ T2 threshold' },
  T2_SPEND_VELOCITY: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0034 Cost Harvesting [verify]', attack: 'T1496 Resource Hijacking', note: 'cumulative/velocity cost-splitting' },
  T1_MERGE: { atlasTactic: 'Persistence', atlasTechnique: 'AML.T0018 Manipulate AI Model [verify]', attack: 'T1195 Supply Chain Compromise', note: 'non-prod merge → adversarial review' },
  T1_NONPROD_CONFIG: { atlasTactic: 'Defense Evasion', atlasTechnique: 'n/a', attack: 'T1578 Modify Cloud Compute Infrastructure', note: 'non-prod config → review' },
  T1_BOUNDED_SPEND: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0034 Cost Harvesting [verify]', attack: 'T1496 Resource Hijacking', note: 'bounded spend → review' },
  T1_FEATURE_PUSH: { atlasTactic: 'Persistence', atlasTechnique: 'n/a', attack: 'T1195 Supply Chain Compromise', note: 'feature-branch push → review' },
  T0_READ: { atlasTactic: 'Discovery / Reconnaissance', atlasTechnique: 'AML.T0007 Discover AI Artifacts [verify]', attack: 'T1083 File and Directory Discovery', note: 'a read — benign alone, counted by the session layer' },
  T0_LOCAL: { atlasTactic: 'n/a (benign)', atlasTechnique: 'n/a', attack: 'n/a', note: 'local/gitignored reversible write' },
  T0_NONEXEC_CONTEXT: { atlasTactic: 'n/a (benign)', atlasTechnique: 'n/a', attack: 'n/a', note: 'doc/test/fixture surface — not executable' },
  UNMATCHED_FAILSAFE: { atlasTactic: 'Defense Evasion (catch-all)', atlasTechnique: 'AML.T0043 Craft Adversarial Data (novel/unknown) [verify]', attack: 'T1027 Obfuscated/Unknown', note: 'unknown action → default-deny T2; covers novel evasions' },
};

/** Per session-risk signal / escalation (the SEQUENCE-attack coverage). */
export const SESSION_ATLAS: Record<SessionSignal | 'RECON_TO_CREDENTIAL' | 'RECON_TO_DESTRUCTIVE' | 'FLOOD', AtlasAnnotation> = {
  read: { atlasTactic: 'Reconnaissance / Discovery', atlasTechnique: 'AML.T0007 Discover AI Artifacts [verify]', attack: 'T1083 File and Directory Discovery', note: 'recon read, accumulated in the session window' },
  write: { atlasTactic: 'Persistence', atlasTechnique: 'n/a', attack: 'T1565 Data Manipulation', note: 'write, accumulated' },
  credential: { atlasTactic: 'Credential Access', atlasTechnique: 'AML.T0055 Unsecured Credentials [verify]', attack: 'T1552 Unsecured Credentials', note: 'token/secret/key access' },
  destructive: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0048 External Harms [verify]', attack: 'T1485 Data Destruction', note: 'destructive op' },
  prod: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0048 External Harms [verify]', attack: 'T1496 Resource Hijacking', note: 'prod-targeted op' },
  spend: { atlasTactic: 'Impact', atlasTechnique: 'AML.T0034 Cost Harvesting [verify]', attack: 'T1496 Resource Hijacking', note: 'spend' },
  other: { atlasTactic: 'unclassified', atlasTechnique: 'n/a', attack: 'n/a', note: 'unrecognized — contributes to score' },
  RECON_TO_CREDENTIAL: { atlasTactic: 'Reconnaissance → Credential Access', atlasTechnique: 'AML.T0007 → AML.T0055 [verify]', attack: 'T1083 → T1552', note: 'PocketOS: scan codebase then read master token — the multi-step escape the session layer catches' },
  RECON_TO_DESTRUCTIVE: { atlasTactic: 'Reconnaissance → Impact', atlasTechnique: 'AML.T0007 → AML.T0048 [verify]', attack: 'T1083 → T1485', note: 'recon then destructive — escalated by the session layer' },
  FLOOD: { atlasTactic: 'Defense Evasion / Impact', atlasTechnique: 'AML.T0046 Spamming AI System with Chaff Data [verify]', attack: 'T1499 Endpoint Denial of Service', note: 'flood T0s to bury a T2 / exhaust the gate — caught by the rate limiter' },
};

/** Adversarial-chamber surface (the LLM-specific techniques, Garak-testable per round-7 GA). */
export const CHAMBER_ATLAS: AtlasAnnotation[] = [
  { atlasTactic: 'Initial Access / Defense Evasion', atlasTechnique: 'AML.T0051 LLM Prompt Injection [verify]', attack: 'n/a (AI-specific)', note: 'injection in the action description aimed at the LLM adversary' },
  { atlasTactic: 'Defense Evasion', atlasTechnique: 'AML.T0054 LLM Jailbreak [verify]', attack: 'n/a (AI-specific)', note: 'jailbreak the adversary into approving a malicious action' },
];

export function atlasForRule(rule: RuleId): AtlasAnnotation {
  return RULE_ATLAS[rule];
}
