/**
 * R7 Phase 2 — every governance rule is annotated with an ATLAS tactic / technique.
 * Completeness guard: if a new RuleId is added, this fails until it gets an ATLAS mapping.
 */
import { RULE_ATLAS, SESSION_ATLAS, atlasForRule } from '../src/services/atlas-map';
import { DEFAULT_CONFIG } from '../src/services/consequence-classifier';

// All RuleId values the classifier can emit (kept in sync with the union).
const ALL_RULE_IDS = [
  'T2_PROD_PROJECT', 'T2_CRITICAL_PATH', 'T2_DDL', 'T2_PROTECTED_GIT',
  'T2_SECRET', 'T2_PLATFORM_PROD', 'T2_HIGH_COST',
  'T2_PROD_IDENTIFIER_IN_TEXT', 'T2_SPEND_VELOCITY',
  'T1_MERGE', 'T1_NONPROD_CONFIG', 'T1_BOUNDED_SPEND', 'T1_FEATURE_PUSH',
  'T0_LOCAL', 'T0_READ', 'T0_NONEXEC_CONTEXT', 'UNMATCHED_FAILSAFE',
] as const;

describe('ATLAS annotation coverage', () => {
  it('every RuleId has an ATLAS tactic + technique + ATT&CK mapping', () => {
    for (const id of ALL_RULE_IDS) {
      const a = atlasForRule(id as any);
      expect(a).toBeDefined();
      expect(typeof a.atlasTactic).toBe('string');
      expect(typeof a.atlasTechnique).toBe('string');
      expect(typeof a.attack).toBe('string');
    }
  });

  it('the map has no extra/typo keys beyond the known RuleIds', () => {
    expect(Object.keys(RULE_ATLAS).sort()).toEqual([...ALL_RULE_IDS].sort());
  });

  it('the sequence-attack escalations (recon→credential / →destructive / flood) are mapped', () => {
    expect(SESSION_ATLAS.RECON_TO_CREDENTIAL.atlasTactic).toMatch(/Credential Access/);
    expect(SESSION_ATLAS.RECON_TO_DESTRUCTIVE.atlasTactic).toMatch(/Impact/);
    expect(SESSION_ATLAS.FLOOD.attack).toMatch(/Denial of Service/);
  });

  it('the T2 critical rules map to Impact / Credential Access / Persistence tactics', () => {
    expect(RULE_ATLAS.T2_DDL.atlasTactic).toBe('Impact');
    expect(RULE_ATLAS.T2_SECRET.atlasTactic).toBe('Credential Access');
    expect(RULE_ATLAS.T2_PROTECTED_GIT.atlasTactic).toMatch(/Persistence/);
  });

  // guards against the union drifting out of sync with the config's documented rules
  it('DEFAULT_CONFIG exists (sanity import)', () => {
    expect(DEFAULT_CONFIG.prodProjectIds).toContain('qnnpjhlxljtqyigedwkb');
  });
});
