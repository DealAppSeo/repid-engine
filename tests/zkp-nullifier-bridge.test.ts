/**
 * ZKP RepID — the bridge's identity-secret gate.
 *
 * Everything here runs in `shadow`, which PERSISTS NOTHING, so no test in this file can
 * touch a live table. The one thing being pinned is that the bridge cannot produce a
 * statement with a weak nullifier secret: it either has a real per-identity secret or
 * it builds nothing and says which variable is missing. A fallback here would be
 * invisible in production — the statement would still look complete.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { recordDeltaStatement } from '../src/zkp/repid-delta-bridge';
import { FORMULA_SALT_ENV, REPID_DELTA_DOMAIN } from '../src/zkp/repid-delta-statement';
import {
  IDENTITY_MASTER_ENV,
  deriveIdentitySecret,
  nullifierMatchesSecret,
} from '../src/zkp/nullifier-identity';

const SALT = 'bridge-test-formula-salt-not-production';
const MASTER = 'bridge-test-identity-master-not-production';

/** A clean event whose delta the formula really does produce (+2 at hal_score 0.75). */
const input = () => ({
  agentId: 'agent-shofet',
  eventLabel: 'score_event:4242',
  deltaApplied: 2,
  scoreBefore: 1611,
  scoreAfter: 1613,
  halScore: 0.75,
  halDecision: 'clean' as const,
  agentTier: 'ESTABLISHED',
  vestingCliffActive: false,
});

const ENV_KEYS = ['REPID_DELTA_STATEMENT_MODE', FORMULA_SALT_ENV, IDENTITY_MASTER_ENV] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('the bridge will not build a statement without a real identity secret', () => {
  it('is inert with no mode set — the default is off and stays off', async () => {
    const r = await recordDeltaStatement(input());
    expect(r.mode).toBe('off');
    expect(r.statement).toBeNull();
    expect(r.persisted).toBe(false);
  });

  it('SKIPS with the mode on but no identity master — it does NOT fall back', async () => {
    // The failure that would otherwise be invisible: a statement built from a
    // public-input-derived secret looks exactly as complete as a real one.
    process.env.REPID_DELTA_STATEMENT_MODE = 'shadow';
    process.env[FORMULA_SALT_ENV] = SALT;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await recordDeltaStatement(input());
      expect(r.skipped).toBe('no-identity-master');
      expect(r.statement).toBeNull();
      expect(r.unlinkability).toBeNull();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain(IDENTITY_MASTER_ENV);
    } finally {
      warn.mockRestore();
    }
  });

  it('SKIPS when the identity master IS the formula salt — key separation, enforced', async () => {
    process.env.REPID_DELTA_STATEMENT_MODE = 'shadow';
    process.env[FORMULA_SALT_ENV] = MASTER;
    process.env[IDENTITY_MASTER_ENV] = MASTER;
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await recordDeltaStatement(input());
      expect(r.skipped).toBe('identity-secret-rejected');
      expect(r.statement).toBeNull();
      expect(String(err.mock.calls[0]?.[0])).toMatch(/two purposes/);
    } finally {
      err.mockRestore();
    }
  });

  it('SKIPS on a master too short to resist brute force', async () => {
    process.env.REPID_DELTA_STATEMENT_MODE = 'shadow';
    process.env[FORMULA_SALT_ENV] = SALT;
    process.env[IDENTITY_MASTER_ENV] = 'tooshort';
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await recordDeltaStatement(input());
      expect(r.skipped).toBe('identity-secret-rejected');
    } finally {
      err.mockRestore();
    }
  });
});

describe('with both secrets configured, shadow builds a bound statement and persists nothing', () => {
  beforeEach(() => {
    process.env.REPID_DELTA_STATEMENT_MODE = 'shadow';
    process.env[FORMULA_SALT_ENV] = SALT;
    process.env[IDENTITY_MASTER_ENV] = MASTER;
  });

  it('binds the nullifier to the agent‘s own identity secret', async () => {
    const r = await recordDeltaStatement(input());
    expect(r.mode).toBe('shadow');
    expect(r.persisted).toBe(false);
    expect(r.skipped).toBeNull();
    expect(r.consistent).toBe(true);

    const expected = deriveIdentitySecret({
      identityId: input().agentId,
      domain: REPID_DELTA_DOMAIN,
      master: MASTER,
    });
    expect(r.statement!.identity_commitment).toBe(expected.commitment);
    expect(
      nullifierMatchesSecret({
        secret: expected,
        domain: REPID_DELTA_DOMAIN,
        scopeLabel: input().eventLabel,
        nullifier: r.statement!.nullifier,
      }),
    ).toBe(true);
  });

  it('TWO DIFFERENT AGENTS GET DIFFERENT IDENTITIES — the axis the old wire lacked', async () => {
    // The old secret was a function of the event label alone, so the same event id
    // under two agents produced the same nullifier and the identity axis did not exist.
    const a = await recordDeltaStatement({ ...input(), agentId: 'agent-a' });
    const b = await recordDeltaStatement({ ...input(), agentId: 'agent-b' });
    expect(a.statement!.identity_commitment).not.toBe(b.statement!.identity_commitment);
    expect(a.statement!.nullifier).not.toBe(b.statement!.nullifier);
  });

  it('ONE agent, two events: same identity, different nullifiers', async () => {
    const a = await recordDeltaStatement({ ...input(), eventLabel: 'score_event:1' });
    const b = await recordDeltaStatement({ ...input(), eventLabel: 'score_event:2' });
    expect(a.statement!.identity_commitment).toBe(b.statement!.identity_commitment);
    expect(a.statement!.nullifier).not.toBe(b.statement!.nullifier);
  });

  it('reports engine-derived linkability rather than implying privacy', async () => {
    const r = await recordDeltaStatement(input());
    expect(r.unlinkability!.source).toBe('engine-derived');
    expect(r.unlinkability!.proven).toBe(false);
    expect(r.unlinkability!.linkable_by.join(' ')).toContain(IDENTITY_MASTER_ENV);
  });

  it('a holder seed takes precedence over the master and reports the stronger source', async () => {
    const r = await recordDeltaStatement({ ...input(), identitySeedHex: '0x' + 'a5'.repeat(32) });
    expect(r.unlinkability!.source).toBe('holder-supplied');
    // Not the engine-derived commitment for this agent.
    const engine = deriveIdentitySecret({
      identityId: input().agentId,
      domain: REPID_DELTA_DOMAIN,
      master: MASTER,
    });
    expect(r.statement!.identity_commitment).not.toBe(engine.commitment);
  });

  it('leaks neither secret into the statement', async () => {
    const r = await recordDeltaStatement({ ...input(), identitySeedHex: '0x' + 'a5'.repeat(32) });
    const blob = JSON.stringify(r.statement);
    expect(blob).not.toContain(MASTER);
    expect(blob).not.toContain(SALT);
    expect(blob).not.toContain('a5a5a5');
  });
});
