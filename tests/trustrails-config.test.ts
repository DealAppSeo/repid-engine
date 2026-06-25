/**
 * TrustRails config surface (round 4 Phase 2) — proves changing config changes behavior.
 */
import { guard } from '../trustrails/guard';
import { loadTrustRailsConfig, parseTrustRailsConfig } from '../trustrails/config';

describe('trustrails.config — the rules are visible and tunable', () => {
  it('loads the shipped trustrails.config.yaml with the canonical rules', () => {
    const cfg = loadTrustRailsConfig(); // resolves trustrails/trustrails.config.yaml
    expect(cfg.classifierConfig.prodProjectIds).toContain('qnnpjhlxljtqyigedwkb');
    expect(cfg.humanSignOffTiers).toContain('T2');
    expect(cfg.classifierConfig.costT2ThresholdUsd).toBe(1.0);
  });

  it('CHANGING costT2ThresholdUsd CHANGES the verdict (T1 → T2) for the same action', () => {
    const spend = { kind: 'spend' as const, costUsd: 0.5, description: 'a fifty-cent spend' };

    const loose = parseTrustRailsConfig({ version: 't', consequence: { costT2ThresholdUsd: 1.0 } });
    const rLoose = guard(spend, { config: loose.classifierConfig });
    expect(rLoose.tier).toBe('T1');
    expect(rLoose.verdict).toBe('REVIEW');

    const strict = parseTrustRailsConfig({ version: 't', consequence: { costT2ThresholdUsd: 0.1 } });
    const rStrict = guard(spend, { config: strict.classifierConfig });
    expect(rStrict.tier).toBe('T2'); // threshold lowered → same spend is now critical
    expect(rStrict.verdict).toBe('BLOCK');
  });

  it('CHANGING humanSignOffTiers to include T1 forces every T1 to BLOCK', () => {
    const merge = { kind: 'git' as const, git: { operation: 'merge' as const, targetRef: 'feat/x' } };

    const def = parseTrustRailsConfig({ version: 't', humanSignOffTiers: ['T2'] });
    expect(guard(merge, { humanSignOffTiers: def.humanSignOffTiers }).verdict).toBe('REVIEW');

    const strict = parseTrustRailsConfig({ version: 't', humanSignOffTiers: ['T1', 'T2'] });
    const r = guard(merge, { humanSignOffTiers: strict.humanSignOffTiers });
    expect(r.verdict).toBe('BLOCK');
    expect(r.log.humanSignOffRequired).toBe(true);
  });

  it('CHANGING criticalPathPatterns can promote a new path to T2', () => {
    const action = { kind: 'file_write' as const, paths: ['infra/terraform.tfstate'], localOnly: true };
    // default: not a critical path AND localOnly → T0
    expect(guard(action, { config: parseTrustRailsConfig({}).classifierConfig }).tier).toBe('T0');
    // add a pattern for tfstate → now T2
    const cfg = parseTrustRailsConfig({ consequence: { criticalPathPatterns: ['\\.tfstate$'] } });
    expect(guard(action, { config: cfg.classifierConfig }).tier).toBe('T2');
  });
});
