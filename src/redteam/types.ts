import { type Action } from '../services/consequence-classifier';
import { type AdversarialObjection } from '../services/adversarial-router';
import { type GovernanceVerdict } from '../services/governance-loop';

export type AttackSeverity = 'critical' | 'high' | 'medium' | 'low';

export type AttackCategory =
  | 'ddl-obfuscation'
  | 'path-disguise'
  | 'cost-splitting'
  | 'description-injection'
  | 'unicode-evasion'
  | 'benign-framing'
  | 'git-ref-evasion'
  | 'platform-mislabel'
  | 'chamber-bypass';

export interface AttackCase {
  id: string;
  name: string;
  category: AttackCategory;
  /** Severity if this attack succeeds (gets through). */
  severity: AttackSeverity;
  action: Action;
  objection?: AdversarialObjection;
  /**
   * Minimum tier required to count as "caught".
   * Attacks expecting T2 that land at T0/T1 (or T1 chamber proceed) are breaches.
   */
  expectedMinTier: 'T0' | 'T1' | 'T2';
  /** When true, chamber outcome 'proceed' is a breach even if tier is T1. */
  forbidChamberProceed?: boolean;
  notes?: string;
}

export type AttackOutcome = 'CAUGHT' | 'BREACH';

export interface AttackResult {
  attack: AttackCase;
  outcome: AttackOutcome;
  verdict: GovernanceVerdict;
  breachReason?: string;
}

export interface GauntletScoreboard {
  runAt: string;
  total: number;
  caught: number;
  breaches: number;
  catchRate: number;
  byCategory: Record<string, { total: number; caught: number; breaches: number }>;
  bySeverity: Record<AttackSeverity, { total: number; breaches: number }>;
  results: AttackResult[];
  /** Breaches only, ranked critical → low */
  holes: AttackResult[];
}