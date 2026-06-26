import { BUILTIN_ATTACKS } from '../builtin';
import { CLASS1_ENCODING } from './class1-encoding';
import { CLASS2_SEMANTIC, CLASS2_SEQUENCES } from './class2-semantic';
import { CLASS3_BOUNDARY } from './class3-boundary';
import { CLASS4_CHAMBER } from './class4-chamber';
import { CLASS5_TRACE } from './class5-trace';
import { CLASS6_ESCAPE, ESCAPE_SEQUENCES } from './class6-escape-replays';
import { CLASS7_FALSE_POSITIVES } from './class7-false-positives';
import { type AttackCaseV2, type AttackSequenceV2 } from '../../types-v2';

export const V2_ATTACKS: AttackCaseV2[] = [
  ...CLASS1_ENCODING,
  ...CLASS2_SEMANTIC,
  ...CLASS3_BOUNDARY,
  ...CLASS4_CHAMBER,
  ...CLASS5_TRACE,
  ...CLASS6_ESCAPE,
  ...CLASS7_FALSE_POSITIVES,
];

export const V2_SEQUENCES: AttackSequenceV2[] = [
  ...CLASS2_SEQUENCES,
  ...ESCAPE_SEQUENCES,
];

/** Round-4 legacy attacks upgraded to v2 shape for dual comparison. */
export function legacyR4AsV2(): AttackCaseV2[] {
  return BUILTIN_ATTACKS.map((a) => ({
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

export const ALL_V2_ATTACKS: AttackCaseV2[] = [...legacyR4AsV2(), ...V2_ATTACKS];