import { isCanonicalAgentName, getCanonicalCategory } from '../../src/services/agent-naming';

describe('agent-naming utility', () => {
  describe('getCanonicalCategory', () => {
    it('should identify trinity category', () => {
      expect(getCanonicalCategory('trinity-sophia')).toBe('trinity');
      expect(getCanonicalCategory('trinity-nexus')).toBe('trinity');
      expect(getCanonicalCategory('trinity-agent-123')).toBe('trinity');
    });

    it('should identify validator category', () => {
      expect(getCanonicalCategory('validator-atlas')).toBe('validator');
      expect(getCanonicalCategory('validator-argus')).toBe('validator');
    });

    it('should identify test category', () => {
      expect(getCanonicalCategory('test-smoke')).toBe('test');
      expect(getCanonicalCategory('test-integration-123')).toBe('test');
    });

    it('should identify user category', () => {
      expect(getCanonicalCategory('user-sean')).toBe('user');
      expect(getCanonicalCategory('user-cash4')).toBe('user');
    });

    it('should identify mock category', () => {
      expect(getCanonicalCategory('mock-openai')).toBe('mock');
      expect(getCanonicalCategory('mock-claude-v2')).toBe('mock');
    });

    it('should classify mixed or non-compliant names as legacy', () => {
      expect(getCanonicalCategory('RAVEN')).toBe('legacy');
      expect(getCanonicalCategory('GUARDIAN')).toBe('legacy');
      expect(getCanonicalCategory('MEDIATOR')).toBe('legacy');
      expect(getCanonicalCategory('trinity-Sophia')).toBe('legacy'); // uppercase letters
      expect(getCanonicalCategory('validator_atlas')).toBe('legacy'); // underscore instead of hyphen
      expect(getCanonicalCategory('test-')).toBe('legacy'); // empty name after hyphen
      expect(getCanonicalCategory('user')).toBe('legacy'); // no prefix + hyphen
    });
  });

  describe('isCanonicalAgentName', () => {
    it('should return true for canonical names and false for legacy', () => {
      expect(isCanonicalAgentName('trinity-sophia')).toBe(true);
      expect(isCanonicalAgentName('validator-atlas')).toBe(true);
      expect(isCanonicalAgentName('test-smoke')).toBe(true);
      expect(isCanonicalAgentName('RAVEN')).toBe(false);
      expect(isCanonicalAgentName('GUARDIAN')).toBe(false);
    });
  });
});
