/**
 * Locks the fail-closed proof-statement guard (corpus hygiene, 2026-08-09).
 *
 * The defect this guards: 7,958 of 22,239 is_real=true rows in repid_zkp_proofs stored
 * an agent-less { repid_score, threshold } statement (score defaulted to 1000). The guard
 * makes that shape unbuildable: no agent binding => no statement => (in the drain) no proof.
 *
 * Placed under tests/ per jest.config.js roots.
 */
import {
  buildBoundStatement,
  isStatementBound,
  assertStatementBound,
  deriveStatementTier,
  isSyntheticAgentId,
  UnboundProofStatementError,
  REQUIRED_STATEMENT_KEYS,
  SYNTHETIC_AGENT_ID,
} from '../src/zkp/proof-statement-guard';

const REAL_AGENT = '11111111-2222-3333-4444-555555555555';

describe('proof-statement-guard — fail-closed agent binding', () => {
  describe('buildBoundStatement', () => {
    it('builds a complete 4-key statement with tier derived from the score', () => {
      const s = buildBoundStatement({ agentId: REAL_AGENT, repidScore: 2280, threshold: 999 });
      expect(s).toEqual({
        agent_id: REAL_AGENT,
        tier: 'ESTABLISHED',
        repid_score: 2280,
        threshold: 999,
      });
      // Exactly the four canonical keys — nothing extra to trip the WASM verifier's struct.
      expect(Object.keys(s).sort()).toEqual([...REQUIRED_STATEMENT_KEYS].sort());
    });

    it('THROWS on a null agent_id (the core pollution case)', () => {
      expect(() => buildBoundStatement({ agentId: null, repidScore: 1000, threshold: 999 }))
        .toThrow(UnboundProofStatementError);
      try {
        buildBoundStatement({ agentId: null, repidScore: 1000, threshold: 999 });
      } catch (e) {
        expect((e as UnboundProofStatementError).reason).toBe('MISSING_AGENT_ID');
      }
    });

    it('THROWS on an empty / whitespace agent_id', () => {
      expect(() => buildBoundStatement({ agentId: '', repidScore: 1000, threshold: 999 }))
        .toThrow(/MISSING_AGENT_ID/);
      expect(() => buildBoundStatement({ agentId: '   ', repidScore: 1000, threshold: 999 }))
        .toThrow(/MISSING_AGENT_ID/);
    });

    it('THROWS on the synthetic sentinel unless allowSynthetic is set', () => {
      expect(() => buildBoundStatement({ agentId: SYNTHETIC_AGENT_ID, repidScore: 1000, threshold: 999 }))
        .toThrow(/SYNTHETIC_AGENT_ID/);
      const s = buildBoundStatement({
        agentId: SYNTHETIC_AGENT_ID,
        repidScore: 1000,
        threshold: 999,
        allowSynthetic: true,
      });
      expect(s.agent_id).toBe(SYNTHETIC_AGENT_ID);
      expect(isStatementBound(s)).toBe(true);
    });

    it('THROWS on a missing or non-finite score', () => {
      expect(() => buildBoundStatement({ agentId: REAL_AGENT, repidScore: null, threshold: 999 }))
        .toThrow(/MISSING_SCORE/);
      expect(() => buildBoundStatement({ agentId: REAL_AGENT, repidScore: Number.NaN, threshold: 999 }))
        .toThrow(/MISSING_SCORE/);
    });

    it('THROWS on a missing or negative threshold', () => {
      expect(() => buildBoundStatement({ agentId: REAL_AGENT, repidScore: 1000, threshold: null }))
        .toThrow(/MISSING_THRESHOLD/);
      expect(() => buildBoundStatement({ agentId: REAL_AGENT, repidScore: 1000, threshold: -1 }))
        .toThrow(/MISSING_THRESHOLD/);
    });

    it('honours an explicit non-blank tier, else derives it', () => {
      expect(buildBoundStatement({ agentId: REAL_AGENT, repidScore: 1000, threshold: 500, tier: 'VETERAN' }).tier)
        .toBe('VETERAN');
      // Blank tier falls back to derivation.
      expect(buildBoundStatement({ agentId: REAL_AGENT, repidScore: 1000, threshold: 500, tier: '  ' }).tier)
        .toBe('ESTABLISHED');
    });

    it('stores repid_score raw (unclamped, unrounded)', () => {
      const s = buildBoundStatement({ agentId: REAL_AGENT, repidScore: 12345.6, threshold: 999 });
      expect(s.repid_score).toBe(12345.6);
      // ...but the tier is derived from the clamped/rounded score.
      expect(s.tier).toBe('VETERAN');
    });
  });

  describe('deriveStatementTier — canonical bands + [10,10000] clamp', () => {
    it('maps scores to the canonical tiers', () => {
      expect(deriveStatementTier(10)).toBe('PROBATIONARY');
      expect(deriveStatementTier(499)).toBe('PROBATIONARY');
      expect(deriveStatementTier(500)).toBe('EARNING');
      expect(deriveStatementTier(999)).toBe('EARNING');
      expect(deriveStatementTier(1000)).toBe('ESTABLISHED');
      expect(deriveStatementTier(4999)).toBe('ESTABLISHED');
      expect(deriveStatementTier(5000)).toBe('AUTONOMOUS');
      expect(deriveStatementTier(7999)).toBe('AUTONOMOUS');
      expect(deriveStatementTier(8000)).toBe('VETERAN');
      expect(deriveStatementTier(999999)).toBe('VETERAN');
      expect(deriveStatementTier(0)).toBe('PROBATIONARY'); // clamps up to 10
    });
  });

  describe('isStatementBound / assertStatementBound', () => {
    it('rejects the legacy agent-less { repid_score, threshold } shape', () => {
      expect(isStatementBound({ repid_score: 1000, threshold: 999 })).toBe(false);
      expect(() => assertStatementBound({ repid_score: 1000, threshold: 999 }))
        .toThrow(/STATEMENT_UNBOUND/);
    });

    it('rejects a statement whose agent_id or tier is blank/null', () => {
      expect(isStatementBound({ agent_id: '', tier: 'ESTABLISHED', repid_score: 1000, threshold: 999 })).toBe(false);
      expect(isStatementBound({ agent_id: REAL_AGENT, tier: null, repid_score: 1000, threshold: 999 })).toBe(false);
    });

    it('accepts a complete bound statement', () => {
      const s = buildBoundStatement({ agentId: REAL_AGENT, repidScore: 1000, threshold: 999 });
      expect(isStatementBound(s)).toBe(true);
      expect(() => assertStatementBound(s)).not.toThrow();
    });

    it('rejects non-objects', () => {
      expect(isStatementBound(null)).toBe(false);
      expect(isStatementBound(undefined)).toBe(false);
      expect(isStatementBound('nope')).toBe(false);
      expect(isStatementBound([])).toBe(false);
    });
  });

  describe('isSyntheticAgentId', () => {
    it('recognises only the all-zero sentinel', () => {
      expect(isSyntheticAgentId(SYNTHETIC_AGENT_ID)).toBe(true);
      expect(isSyntheticAgentId(REAL_AGENT)).toBe(false);
      expect(isSyntheticAgentId(null)).toBe(false);
    });
  });
});
