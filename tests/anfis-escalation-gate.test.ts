/**
 * ANFIS escalation-only gate (2026-07-30).
 *
 * Context: full ANFIS authority would hand routing to an UNFITTED policy —
 * verified live, `anfis_routing_logs` = 256 rows all-time / 34 in 7d (~5
 * decisions/day across all providers) while retune is OFF and needs 20 samples
 * PER PROVIDER PER 24h. So ANFIS goes live in one direction only: it may
 * escalate (cost you can measure) and may never de-escalate (silent quality
 * loss). Routing-layer twin of amendment A2 on the preference vector.
 *
 * These tests pin the asymmetry, the inviolable stakes floor, and — critically
 * — that requesting the unimplemented `live` mode degrades LOUDLY to
 * escalate_only rather than silently granting authority.
 */
import {
  applyEscalationOnly,
  anfisRoutingMode,
  tierRank,
} from '../src/services/anfis-escalation-gate';

const ORIGINAL = process.env.ANFIS_ROUTING_MODE;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ANFIS_ROUTING_MODE;
  else process.env.ANFIS_ROUTING_MODE = ORIGINAL;
});

describe('anfisRoutingMode', () => {
  test('defaults to shadow when unset', () => {
    delete process.env.ANFIS_ROUTING_MODE;
    expect(anfisRoutingMode()).toBe('shadow');
  });

  test('escalate_only is honored', () => {
    process.env.ANFIS_ROUTING_MODE = 'escalate_only';
    expect(anfisRoutingMode()).toBe('escalate_only');
  });

  test('live degrades LOUDLY to escalate_only — never silently granted', () => {
    process.env.ANFIS_ROUTING_MODE = 'live';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(anfisRoutingMode()).toBe('escalate_only');
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).toMatch(/unfitted|NOT implemented/i);
    warn.mockRestore();
  });

  test('unknown values fall back to shadow (safe default)', () => {
    process.env.ANFIS_ROUTING_MODE = 'yolo';
    expect(anfisRoutingMode()).toBe('shadow');
  });
});

describe('tier ladder', () => {
  test('slm < tier0 < tier1', () => {
    expect(tierRank('slm')).toBeLessThan(tierRank('0a'));
    expect(tierRank('0a')).toBeLessThan(tierRank('1'));
  });
  test('unknown tiers default to tier0 rather than 0 (never silently the floor)', () => {
    expect(tierRank('nonsense')).toBe(tierRank('0a'));
    expect(tierRank(null)).toBe(tierRank('0a'));
  });
});

describe('applyEscalationOnly', () => {
  const base = { staticProvider: 'groq', staticTier: '0a' };

  test('shadow mode never applies the recommendation', () => {
    const d = applyEscalationOnly({
      ...base, anfisProvider: 'gpt-4o', anfisTier: '1', mode: 'shadow',
    });
    expect(d.provider).toBe('groq');
    expect(d.tier).toBe('0a');
    expect(d.escalated).toBe(false);
  });

  test('escalation is adopted', () => {
    const d = applyEscalationOnly({
      ...base, anfisProvider: 'gpt-4o', anfisTier: '1', mode: 'escalate_only',
    });
    expect(d.tier).toBe('1');
    expect(d.provider).toBe('gpt-4o');
    expect(d.escalated).toBe(true);
  });

  test('DE-ESCALATION IS REFUSED — the core guarantee', () => {
    const d = applyEscalationOnly({
      ...base, anfisProvider: 'llama-3-2-1b', anfisTier: 'slm', mode: 'escalate_only',
    });
    expect(d.tier).toBe('0a');           // unchanged
    expect(d.provider).toBe('groq');     // unchanged
    expect(d.deescalation_blocked).toBe(true);
    expect(d.reason).toMatch(/de-escalation refused/);
  });

  test('the stakes floor is inviolable even when the static router sits below it', () => {
    const d = applyEscalationOnly({
      staticProvider: 'llama-3-2-1b', staticTier: 'slm',
      anfisProvider: 'llama-3-2-1b', anfisTier: 'slm',
      stakesFloorTier: '1',            // high stakes: never an SLM
      mode: 'escalate_only',
    });
    expect(d.deescalation_blocked).toBe(true);
    expect(d.reason).toMatch(/stakes floor/);
  });

  test('lateral same-tier moves are permitted (capability preserved, family diversity gained)', () => {
    const d = applyEscalationOnly({
      ...base, anfisProvider: 'cerebras', anfisTier: '0a', mode: 'escalate_only',
    });
    expect(d.provider).toBe('cerebras');
    expect(d.tier).toBe('0a');
    expect(d.escalated).toBe(false);
    expect(d.deescalation_blocked).toBe(false);
  });

  test('agreement is a no-op', () => {
    const d = applyEscalationOnly({
      ...base, anfisProvider: 'groq', anfisTier: '0a', mode: 'escalate_only',
    });
    expect(d.provider).toBe('groq');
    expect(d.reason).toMatch(/agreed/);
  });

  test('property: escalate_only never lowers capability, for any recommendation', () => {
    const tiers = ['slm', '0a', '1'];
    for (const st of tiers) {
      for (const at of tiers) {
        const d = applyEscalationOnly({
          staticProvider: 'groq', staticTier: st,
          anfisProvider: 'x', anfisTier: at,
          mode: 'escalate_only',
        });
        expect(tierRank(d.tier)).toBeGreaterThanOrEqual(tierRank(st));
      }
    }
  });
});
