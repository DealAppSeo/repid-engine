/**
 * Who may mint a BYOK identity token, and how many may exist (2026-08-25).
 *
 * WHY THIS GATE EXISTS. A BYOK token is a bounded budget of OUR provider spend —
 * it does not carry the holder's own provider keys, whatever the name suggests
 * (see middleware/ip-rate-limit.ts). `mintClaimable` is deliberately NOT behind a
 * wallet proof: its entire purpose is issuing to someone with no wallet yet. Put
 * those two facts together and an ungated claimable mint is an open door to
 * unlimited budgets, which is what flipping IDENTITY_TOKENS_ENABLED would have
 * opened before this.
 *
 * THE TWO ASSERTIONS THAT CARRY THE CONTROL are the fail-closed ones: minting
 * with NO codes configured, and minting when the count query fails. Both are the
 * "we could not check" case, and both must refuse. A per-token budget bounds
 * nothing if the number of tokens is unbounded, so the cap is not a nicety — it
 * is the second half of the arithmetic:
 *
 *     evaluations/day  <=  free-tier ceiling  +  (live tokens x per-token budget)
 *
 * These tests drive the REAL mintClaimable with a faked db, rather than asserting
 * on a re-implementation of its rules, so a rule deleted from the service fails
 * here instead of quietly passing.
 */

// The service reads its flag at MODULE LOAD, so the env must be set before the
// import. That is also true in production — Railway restarts on a variable
// change, which is what makes the flag take effect there.
process.env.IDENTITY_TOKENS_ENABLED = 'true';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

/** Count returned by the live-token query, and whether that query errors. */
let liveClaimable = 0;
let countErrors = false;
let inserted: Record<string, unknown> | null = null;

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      // .select('id', { count: 'exact', head: true }).eq(...).eq(...) -> { count, error }
      select: (_cols: string, opts?: { head?: boolean }) => {
        if (opts?.head) {
          const chain: any = {
            eq: () => chain,
            then: (resolve: (v: unknown) => unknown) =>
              resolve({ count: countErrors ? null : liveClaimable, error: countErrors ? { message: 'count failed' } : null }),
          };
          return chain;
        }
        return { maybeSingle: async () => ({ data: null, error: { message: 'unexpected' } }) };
      },
      insert: (row: Record<string, unknown>) => {
        inserted = row;
        return {
          select: () => ({
            maybeSingle: async () => ({
              data: { id: 'tok-new', key_prefix: 'abcd1234', owner_kind: 'claimable', repid_agent_id: null, status: 'active', created_at: 'now' },
              error: null,
            }),
          }),
        };
      },
    }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { mintClaimable } = require('../src/services/identity-token');

/** A well-formed Poseidon2-shaped commitment, so nothing fails for the wrong reason. */
const COMMITMENT = 'a'.repeat(64);

beforeEach(() => {
  liveClaimable = 0;
  countErrors = false;
  inserted = null;
  process.env.BYOK_INVITE_CODES = 'hackathon-2026,partner-alpha';
  process.env.BYOK_MAX_CLAIMABLE = '100';
});

describe('an invite code is required to mint a claimable token', () => {
  it('mints with a valid code', async () => {
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^hdg_byok_/);
    expect((inserted as any)?.owner_kind).toBe('claimable');
  });

  it('accepts any of the configured codes, not just the first', async () => {
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'partner-alpha' });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['a wrong code', 'not-a-code'],
    ['an empty code', ''],
    ['a prefix of a real code', 'hackathon'],
    ['a real code with trailing junk', 'hackathon-2026x'],
  ])('refuses %s', async (_label, code) => {
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: code });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
    expect(inserted).toBeNull();
  });

  it('refuses when the caller supplies no code at all', async () => {
    const r = await mintClaimable({ claimCommitment: COMMITMENT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('REFUSES EVERYTHING when no codes are configured', async () => {
    // The load-bearing one. "No codes set" must mean "nobody may mint", never
    // "anybody may mint" — otherwise the dangerous state is the one you reach by
    // forgetting to configure something, which is the state people reach.
    delete process.env.BYOK_INVITE_CODES;
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
    expect(inserted).toBeNull();
  });
});

describe('the number of live tokens is capped, which is what makes the budget a bound', () => {
  it('mints while under the cap', async () => {
    liveClaimable = 99;
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(true);
  });

  it('refuses at the cap', async () => {
    liveClaimable = 100;
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
    expect(r.detail).toMatch(/cap \(100\)/);
    expect(inserted).toBeNull();
  });

  it('refuses past the cap, not just exactly at it', async () => {
    liveClaimable = 5000;
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(false);
  });

  it('a cap of 0 closes claimable minting entirely', async () => {
    process.env.BYOK_MAX_CLAIMABLE = '0';
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('forbidden');
  });

  it('REFUSES when the live count cannot be read', async () => {
    // The other load-bearing one. An unreadable count is "we do not know how many
    // exist", and minting into that is how a cap silently stops being a cap.
    countErrors = true;
    const r = await mintClaimable({ claimCommitment: COMMITMENT, inviteCode: 'hackathon-2026' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('write_failed');
    expect(inserted).toBeNull();
  });
});

describe('the gates run before the commitment is even examined', () => {
  it('an uninvited caller with a malformed commitment is told about the invite', async () => {
    // Otherwise a hackathon participant without a code gets sent off debugging
    // their Poseidon2 output, which is the wrong answer to their actual problem.
    const r = await mintClaimable({ claimCommitment: 'not-hex', inviteCode: 'wrong' });
    expect(r.reason).toBe('forbidden');
  });
});
