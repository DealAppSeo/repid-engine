/**
 * Anti-Sybil MVP (2026-07-07) — PROVISIONAL↔ECONOMIC band guard hook.
 * Proves: flag OFF is a no-op (every agent economic-standing → no behavior
 * change); flag ON gates economic standing on an active bond / explicit band.
 */
import {
  isEconomicStanding,
  classifyBand,
  economicBandGateEnabled,
} from '../../src/services/economic-standing';

describe('economic-standing band guard hook', () => {
  const OLD = process.env.REPID_ECONOMIC_BAND_ENABLED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.REPID_ECONOMIC_BAND_ENABLED;
    else process.env.REPID_ECONOMIC_BAND_ENABLED = OLD;
  });

  describe('flag OFF (default) — inert wiring point, no behavior change', () => {
    beforeEach(() => { delete process.env.REPID_ECONOMIC_BAND_ENABLED; });

    it('gate reports disabled', () => {
      expect(economicBandGateEnabled()).toBe(false);
    });
    it('every agent is economic-standing (bonded or not, even null)', () => {
      expect(isEconomicStanding(null)).toBe(true);
      expect(isEconomicStanding(undefined)).toBe(true);
      expect(isEconomicStanding({ has_active_bond: false })).toBe(true);
      expect(isEconomicStanding({ has_active_bond: true })).toBe(true);
    });
    it('classifyBand reads PROVISIONAL unless an explicit band is set', () => {
      expect(classifyBand({ has_active_bond: true })).toBe('PROVISIONAL');
      expect(classifyBand({ band: 'GOVERNANCE' })).toBe('GOVERNANCE');
    });
  });

  describe('flag ON — economic standing gated on bond / explicit band', () => {
    beforeEach(() => { process.env.REPID_ECONOMIC_BAND_ENABLED = 'true'; });

    it('gate reports enabled', () => {
      expect(economicBandGateEnabled()).toBe(true);
    });
    it('no bond ⇒ provisional ⇒ NOT economic standing', () => {
      expect(isEconomicStanding(null)).toBe(false);
      expect(isEconomicStanding({ has_active_bond: false })).toBe(false);
      expect(isEconomicStanding({})).toBe(false);
    });
    it('active bond ⇒ economic standing', () => {
      expect(isEconomicStanding({ has_active_bond: true })).toBe(true);
      expect(classifyBand({ has_active_bond: true })).toBe('ECONOMIC');
    });
    it('explicit ECONOMIC/VERIFIER/GOVERNANCE band ⇒ economic standing', () => {
      expect(isEconomicStanding({ band: 'ECONOMIC', has_active_bond: false })).toBe(true);
      expect(isEconomicStanding({ band: 'VERIFIER', has_active_bond: false })).toBe(true);
      expect(isEconomicStanding({ band: 'GOVERNANCE', has_active_bond: false })).toBe(true);
    });
  });
});
