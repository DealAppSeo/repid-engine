import { type Action } from '../services/consequence-classifier';
import { type AdversarialObjection, type ChamberParticipant } from '../services/adversarial-router';
import { type GovernanceVerdict } from '../services/governance-loop';

export type AttackSeverity = 'critical' | 'high' | 'medium' | 'low';

/** CVSS-style impact if attack succeeds (0–10). */
export type CvssScore = number;

export type AttackClass =
  | 'encoding-evasion'
  | 'semantic-intent'
  | 'boundary-velocity'
  | 'chamber-attack'
  | 'trace-integrity'
  | 'escape-replay'
  | 'false-positive';

export type AttackDirection = 'breach' | 'false-positive';

export interface AttackCaseV2 {
  id: string;
  name: string;
  attackClass: AttackClass;
  direction: AttackDirection;
  severity: AttackSeverity;
  cvss: CvssScore;
  action: Action;
  objection?: AdversarialObjection;
  proposer?: ChamberParticipant;
  adversary?: ChamberParticipant;
  /** Breach tests: minimum tier to count as caught. */
  expectedMinTier?: 'T0' | 'T1' | 'T2';
  /** False-positive tests: must NOT exceed this tier. */
  expectedMaxTier?: 'T0' | 'T1';
  forbidChamberProceed?: boolean;
  /** Rules this attack is meant to exercise (coverage map). */
  coveredRules: string[];
  notes?: string;
}

export interface AttackSequenceV2 {
  id: string;
  name: string;
  attackClass: AttackClass;
  direction: 'breach';
  severity: AttackSeverity;
  cvss: CvssScore;
  steps: { label: string; action: Action }[];
  /** Breach if composite criterion met. */
  breachWhen: 'any-step-auto-proceed' | 'velocity-spend-exceeds' | 'all-steps-below-T2';
  spendCapUsd?: number;
  expectedMinTier: 'T2';
  coveredRules: string[];
  notes?: string;
}

export type AttackOutcome = 'PASS' | 'BREACH' | 'FALSE_POSITIVE';

export interface AttackResultV2 {
  id: string;
  name: string;
  attackClass: AttackClass;
  direction: AttackDirection;
  severity: AttackSeverity;
  cvss: CvssScore;
  outcome: AttackOutcome;
  verdict?: GovernanceVerdict;
  stepVerdicts?: GovernanceVerdict[];
  breachReason?: string;
  coveredRules: string[];
}

export interface ClassScoreboard {
  attackClass: AttackClass;
  total: number;
  pass: number;
  breaches: number;
  falsePositives: number;
  catchRate: number;
}

export interface GauntletScoreboardV2 {
  profileId: string;
  runAt: string;
  total: number;
  breachTests: number;
  falsePositiveTests: number;
  caught: number;
  breaches: number;
  falsePositives: number;
  breachCatchRate: number;
  falsePositivePassRate: number;
  byClass: ClassScoreboard[];
  bySeverity: Record<AttackSeverity, { total: number; breaches: number }>;
  results: AttackResultV2[];
  holes: AttackResultV2[];
  overBlocks: AttackResultV2[];
}

export interface CoverageMapEntry {
  ruleId: string;
  attackCount: number;
  attackIds: string[];
}

export interface DualScoreboard {
  before: GauntletScoreboardV2;
  after: GauntletScoreboardV2;
  delta: {
    breachCatchRate: number;
    falsePositivePassRate: number;
    breachesClosed: string[];
    newBreaches: string[];
  };
  coverageMap: CoverageMapEntry[];
  hardenedSource: string;
}