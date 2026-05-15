export type TestTier =
  | 'T0_INTERNAL_DEV_TEST'
  | 'T1_INTERNAL_SIMULATION'
  | 'T2a_INTERNAL_REAL_ORGANIC'
  | 'T2b_INTERNAL_REAL_ADVERSARIAL'
  | 'T3a_EXTERNAL_TEST_PRIVATE'
  | 'T3b_EXTERNAL_TEST_PUBLIC'
  | 'T4_EXTERNAL_REAL_PRODUCTION';

export interface ProvenanceTags {
  test_tier: TestTier;
  test_source: string;
  external_party_id?: string | null;
  external_party_aware?: boolean | null;
  adversarial_planted?: boolean;
  brain_provenance?: string[];
  patent_eligible?: boolean;
  patent_classes?: string[];
  provenance_notes?: string;
  provenance_tagged_at: string; // ISO timestamp
}

/**
 * Build provenance tags for a new task. See PROVENANCE_FRAMEWORK_v1.md.
 */
export function provenance(
  tier: TestTier,
  source: string,
  overrides: Partial<ProvenanceTags> = {}
): ProvenanceTags {
  const isInternal = tier.startsWith('T0') || tier.startsWith('T1') || tier.startsWith('T2');
  return {
    test_tier: tier,
    test_source: source,
    external_party_id: isInternal ? null : (overrides.external_party_id ?? null),
    external_party_aware: isInternal ? null : (overrides.external_party_aware ?? null),
    adversarial_planted: tier === 'T2b_INTERNAL_REAL_ADVERSARIAL' || (overrides.adversarial_planted ?? false),
    brain_provenance: overrides.brain_provenance ?? [],
    patent_eligible: overrides.patent_eligible ?? (tier !== 'T0_INTERNAL_DEV_TEST' && tier !== 'T1_INTERNAL_SIMULATION'),
    patent_classes: overrides.patent_classes ?? [],
    provenance_notes: overrides.provenance_notes ?? '',
    provenance_tagged_at: new Date().toISOString()
  };
}
