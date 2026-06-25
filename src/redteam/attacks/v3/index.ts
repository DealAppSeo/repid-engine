import { BUILTIN_ATTACKS } from '../builtin';
import { CLASS1_ENCODING } from '../v2/class1-encoding';
import { CLASS2_SEMANTIC } from '../v2/class2-semantic';
import { CLASS3_BOUNDARY } from '../v2/class3-boundary';
import { CLASS4_CHAMBER } from '../v2/class4-chamber';
import { CLASS5_TRACE } from '../v2/class5-trace';
import { CLASS6_ESCAPE } from '../v2/class6-escape-replays';
import { CLASS7_FALSE_POSITIVES } from '../v2/class7-false-positives';
import { SESSION_ATTACKS, SESSION_SEQUENCES } from './session-attacks';
import { type AttackCaseV2 } from '../../types-v2';
import { type AttackCaseV3, type AttackSequenceV3 } from '../../types-v3';

const LEGACY_EXCLUDE_FROM_BREACH = new Set(['cost-001']);

/** Legacy r4 attacks — cost-001 re-spec'd as sess-cost-lone (FP) + sess-cost-burst (sequence). */
export function legacyR4AsV3(): AttackCaseV2[] {
  return BUILTIN_ATTACKS.filter((a) => !LEGACY_EXCLUDE_FROM_BREACH.has(a.id)).map((a) => ({
    id: `r4-${a.id}`,
    name: `[r4] ${a.name}`,
    attackClass: mapLegacyCategory(a.category),
    direction: 'breach' as const,
    severity: a.severity,
    cvss: severityToCvss(a.severity),
    action: a.action,
    objection: a.objection,
    expectedMinTier: a.expectedMinTier,
    forbidChamberProceed: a.forbidChamberProceed,
    coveredRules: [a.category],
    notes: a.notes,
  }));
}

function mapLegacyCategory(cat: string): AttackCaseV2['attackClass'] {
  if (cat.includes('git')) return 'encoding-evasion';
  if (cat.includes('ddl') || cat.includes('unicode')) return 'encoding-evasion';
  if (cat.includes('cost')) return 'boundary-velocity';
  if (cat.includes('description')) return 'semantic-intent';
  return 'semantic-intent';
}

function severityToCvss(s: AttackCaseV2['severity']): number {
  return { critical: 9.5, high: 8.0, medium: 6.0, low: 3.0 }[s];
}

/** v3 corpus: legacy (minus cost-001) + v2 singles + session FP + no duplicate v2 escape sequences. */
export const V3_ATTACKS: AttackCaseV3[] = [
  ...legacyR4AsV3(),
  ...CLASS1_ENCODING,
  ...CLASS2_SEMANTIC,
  ...CLASS3_BOUNDARY,
  ...CLASS4_CHAMBER,
  ...CLASS5_TRACE,
  ...CLASS6_ESCAPE.filter((a) => a.id !== 'esc-pocket-1'),
  ...CLASS7_FALSE_POSITIVES,
  ...SESSION_ATTACKS,
];

/** v3 sequences: session chains only (replaces v2 escape/cost sequences for parity run). */
export const V3_SEQUENCES: AttackSequenceV3[] = [...SESSION_SEQUENCES];

export const ALL_V3_ATTACKS = V3_ATTACKS;
export const ALL_V3_SEQUENCES = V3_SEQUENCES;