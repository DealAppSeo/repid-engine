import { classifyAction } from '../src/services/consequence-classifier';
import { tryDecodeBase64, tryDecodeHex } from '../src/services/canonicalize';

describe('Round-7 Paired Safety (No False Positives)', () => {
  describe('Decoder Robustness', () => {
    it('does not decode common base64-like English words to printable ASCII', () => {
      // "postgres" is a valid base64 word of length 8, but decodes to binary garbage,
      // which should be rejected by the printable ASCII check.
      const decoded = tryDecodeBase64('postgres');
      expect(decoded).toBeNull();
    });

    it('does not decode short words', () => {
      const decoded = tryDecodeBase64('drop'); // length 4, but tryDecodeBase64 skips length < 8
      expect(decoded).toBeNull();
    });

    it('does not decode hex-like strings that represent non-printable data', () => {
      const decoded = tryDecodeHex('0001020304050607'); // non-printable ASCII
      expect(decoded).toBeNull();
    });
  });

  describe('DDL Raw Description Exemption (FP Safety)', () => {
    it('does not trigger T2_DDL on file_write code comments containing DROP TABLE (fp-001)', () => {
      const action = {
        kind: 'file_write',
        localOnly: true,
        paths: ['src/services/example.ts'],
        description: '// TODO: DROP TABLE legacy_cache when migrated',
      };
      const classification = classifyAction(action);
      // Since localOnly is true, it triggers T0_LOCAL.
      // Since kind is file_write, raw description is exempt from DDL checks.
      expect(classification.tier).toBe('T0');
      expect(classification.hits.some(h => h.ruleId === 'T2_DDL')).toBe(false);
    });

    it('does not trigger T2_DDL on git merge/push descriptions containing DROP (non-executable kind)', () => {
      const action = {
        kind: 'git',
        git: { operation: 'merge', targetRef: 'feature/not-main' },
        description: 'merge features, drop legacy support',
      };
      const classification = classifyAction(action);
      // Since targetRef is non-protected, it triggers T1_MERGE.
      // Since kind is git, raw description is exempt from DDL checks.
      expect(classification.tier).toBe('T1');
      expect(classification.hits.some(h => h.ruleId === 'T2_DDL')).toBe(false);
    });
  });

  describe('Spend Boundary Precision', () => {
    it('classifies legitimate $0.99 spend as T1 (fp-004)', () => {
      const action = { kind: 'spend', costUsd: 0.99, description: 'legitimate micro-spend' };
      const classification = classifyAction(action);
      expect(classification.tier).toBe('T1');
      expect(classification.hits.some(h => h.ruleId === 'T1_BOUNDED_SPEND')).toBe(true);
      expect(classification.hits.some(h => h.ruleId === 'T2_HIGH_COST')).toBe(false);
    });

    it('classifies legitimate $0.01 spend as T1', () => {
      const action = { kind: 'spend', costUsd: 0.01, description: 'micro-payment' };
      const classification = classifyAction(action);
      expect(classification.tier).toBe('T1');
      expect(classification.hits.some(h => h.ruleId === 'T1_BOUNDED_SPEND')).toBe(true);
    });
  });
});
