/**
 * Issuer identity at the HAL write site.
 *
 * The properties that matter here are the REFUSALS, not the happy path. Each
 * one corresponds to a live constraint on `repid_score_events` that would
 * otherwise abort an insert, or to a production measurement that showed a
 * plausible-looking value to be meaningless:
 *
 *   issuer_is_subject     → repid_score_events_counterparty_not_self (23514)
 *   issuer_id_malformed   → repid_score_events_counterparty_fkey     (23503)
 *   normaliseProvidersUsed(undefined) === null
 *                         → every stored 0 in production is an ABSENT signal
 *                           coalesced by `?? 0`, never a measured zero.
 */
import {
  resolveIssuerIdentity,
  normaliseProvidersUsed,
  issuerIdentityEnabled,
} from '../src/scoring/issuer-identity';

const SUBJECT = '11111111-2222-3333-4444-555555555555';
const ISSUER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const on = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    HAL_ISSUER_IDENTITY_ENABLED: 'true',
    HAL_ISSUER_AGENT_ID: ISSUER,
    ...extra,
  }) as NodeJS.ProcessEnv;

describe('issuerIdentityEnabled — default OFF', () => {
  it('is false when the flag is absent', () => {
    expect(issuerIdentityEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is false for anything that is not the exact string "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      expect(
        issuerIdentityEnabled({ HAL_ISSUER_IDENTITY_ENABLED: v } as NodeJS.ProcessEnv)
      ).toBe(false);
    }
  });

  it('is true only for "true"', () => {
    expect(
      issuerIdentityEnabled({ HAL_ISSUER_IDENTITY_ENABLED: 'true' } as NodeJS.ProcessEnv)
    ).toBe(true);
  });
});

describe('resolveIssuerIdentity — refusals carry a reason', () => {
  it('refuses with "disabled" when the flag is off, even with an id configured', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT,
      rawProvidersUsed: 3,
      env: { HAL_ISSUER_AGENT_ID: ISSUER } as NodeJS.ProcessEnv,
    });
    expect(r).toEqual({ recorded: false, reason: 'disabled' });
  });

  it('reports "disabled" BEFORE "no_issuer_configured" — an operator who has not opted in is not misconfigured', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT,
      rawProvidersUsed: null,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(r).toEqual({ recorded: false, reason: 'disabled' });
  });

  it('refuses when the flag is on but no id is configured', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT,
      rawProvidersUsed: 2,
      env: { HAL_ISSUER_IDENTITY_ENABLED: 'true' } as NodeJS.ProcessEnv,
    });
    expect(r).toEqual({ recorded: false, reason: 'no_issuer_configured' });
  });

  it('refuses a non-uuid id rather than sending it at the foreign key', () => {
    for (const bad of ['trinity-hal', '', '  ', 'aaaaaaaa-bbbb-cccc-dddd', '0x1234']) {
      const r = resolveIssuerIdentity({
        subjectAgentId: SUBJECT,
        rawProvidersUsed: 2,
        env: on({ HAL_ISSUER_AGENT_ID: bad }),
      });
      expect(r.recorded).toBe(false);
      if (!r.recorded) {
        expect(['no_issuer_configured', 'issuer_id_malformed']).toContain(r.reason);
      }
    }
  });

  it('refuses when the issuer IS the subject — counterparty_not_self would reject the row', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT,
      rawProvidersUsed: 2,
      env: on({ HAL_ISSUER_AGENT_ID: SUBJECT }),
    });
    expect(r).toEqual({ recorded: false, reason: 'issuer_is_subject' });
  });

  it('treats uuid case and surrounding whitespace as the same row, so self-judgement cannot slip past', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT.toUpperCase(),
      rawProvidersUsed: 2,
      env: on({ HAL_ISSUER_AGENT_ID: `  ${SUBJECT}  ` }),
    });
    expect(r).toEqual({ recorded: false, reason: 'issuer_is_subject' });
  });
});

describe('resolveIssuerIdentity — the recorded shape', () => {
  it('emits exactly the three migration columns, and the role literal the CHECK allows', () => {
    const r = resolveIssuerIdentity({
      subjectAgentId: SUBJECT,
      rawProvidersUsed: 3,
      env: on(),
    });
    expect(r).toEqual({
      recorded: true,
      fields: {
        counterparty_agent_id: ISSUER,
        counterparty_role: 'verdict_issuer',
        issuer_providers_used_n: 3,
      },
    });
    // Guards the coupling to the migration: a fourth key here is a column that
    // does not exist, and every insert would fail.
    if (r.recorded) {
      expect(Object.keys(r.fields).sort()).toEqual([
        'counterparty_agent_id',
        'counterparty_role',
        'issuer_providers_used_n',
      ]);
    }
  });
});

describe('normaliseProvidersUsed — NOT RECORDED and MEASURED ZERO are different', () => {
  it('returns null for an absent signal — this is the whole point', () => {
    expect(normaliseProvidersUsed(undefined)).toBeNull();
    expect(normaliseProvidersUsed(null)).toBeNull();
  });

  it('returns 0 only when 0 was actually reported', () => {
    expect(normaliseProvidersUsed(0)).toBe(0);
    expect(normaliseProvidersUsed('0')).toBe(0);
  });

  it('never coalesces absence to zero (the live defect it exists to avoid)', () => {
    expect(normaliseProvidersUsed(undefined)).not.toBe(0);
  });

  it('refuses values that cannot be a provider count', () => {
    expect(normaliseProvidersUsed('two')).toBeNull();
    expect(normaliseProvidersUsed(NaN)).toBeNull();
    expect(normaliseProvidersUsed(Infinity)).toBeNull();
    expect(normaliseProvidersUsed(-1)).toBeNull();
    expect(normaliseProvidersUsed(true)).toBeNull();
    expect(normaliseProvidersUsed(false)).toBeNull();
  });

  it('floors a fractional count rather than losing the observation', () => {
    expect(normaliseProvidersUsed(2.9)).toBe(2);
  });

  it('refuses an array — an EMPTY provider list must not become a measured zero', () => {
    // Number([]) is 0 and Number([3]) is 3; both would be fail-OPEN coercions of
    // the corrupt persisted list shape (see src/hal/provider-width.ts).
    expect(normaliseProvidersUsed([])).toBeNull();
    expect(normaliseProvidersUsed([3])).toBeNull();
    expect(normaliseProvidersUsed(['groq', 'cerebras'])).toBeNull();
    expect(normaliseProvidersUsed({})).toBeNull();
    expect(normaliseProvidersUsed('')).toBeNull();
    expect(normaliseProvidersUsed('   ')).toBeNull();
  });
});
