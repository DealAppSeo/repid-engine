/**
 * Mocked unit tests for explicit human→agent delegation authority.
 *
 * Covers: valid delegation passes; expired / revoked / over-scope / bad-signature / not-owner
 * all rejected; DELEGATION_REQUIRED=OFF preserves current implicit (no-op) behavior.
 *
 * No network / no live Supabase — `db` is jest-mocked, EIP-712 signing is done locally with a
 * throwaway ethers Wallet.
 */
import { Wallet } from 'ethers';
import { db } from '../../src/db';
import {
  DELEGATION_DOMAIN,
  DELEGATION_TYPES,
  buildDelegationTypedData,
  recoverDelegationSigner,
  decideCoverage,
  recordDelegation,
  assertDelegationCovers,
  delegationRequired,
  type DelegationMessage,
  type DelegationRow,
} from '../../src/services/agent-delegation';

jest.mock('../../src/db', () => ({ db: { from: jest.fn() } }));

const mockedFrom = db.from as jest.Mock;

const AGENT = 'trinity-worker-7';
const BUILDER_ID = '11111111-1111-1111-1111-111111111111';

async function signDelegation(
  wallet: Wallet,
  overrides: Partial<DelegationMessage> = {},
): Promise<{ message: DelegationMessage; signature: string }> {
  const message: DelegationMessage = {
    delegator: wallet.address,
    agent: AGENT,
    maxUsdcPerTx: 100,
    maxUsdcTotal: 1000,
    expiry: Math.floor(Date.now() / 1000) + 3600, // +1h
    nonce: 1,
    ...overrides,
  };
  const signature = await wallet.signTypedData(DELEGATION_DOMAIN, DELEGATION_TYPES, message);
  return { message, signature };
}

/** Mock db.from so repid_agents -> builder_id and builders -> address resolve to `ownerAddress`. */
function mockOwnership(ownerAddress: string | null, opts: { agentExists?: boolean } = {}) {
  const agentExists = opts.agentExists ?? true;
  mockedFrom.mockImplementation((table: string) => {
    if (table === 'repid_agents') {
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest
          .fn()
          .mockResolvedValue({ data: agentExists ? { builder_id: BUILDER_ID } : null }),
      };
    }
    if (table === 'builders') {
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest
          .fn()
          .mockResolvedValue({ data: ownerAddress ? { address: ownerAddress } : null }),
      };
    }
    if (table === 'agent_delegations') {
      return {
        insert: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { id: 'del-1' }, error: null }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env['DELEGATION_REQUIRED'];
});

// --- EIP-712 domain / recovery ---------------------------------------------

describe('EIP-712 delegation signing', () => {
  it('exposes the Base Sepolia (84532) domain and the Delegation type', () => {
    expect(DELEGATION_DOMAIN.chainId).toBe(84532);
    expect(DELEGATION_TYPES.Delegation.map((f) => f.name)).toEqual([
      'delegator',
      'agent',
      'maxUsdcPerTx',
      'maxUsdcTotal',
      'expiry',
      'nonce',
    ]);
  });

  it('recovers the signer from a valid signature', async () => {
    const wallet = Wallet.createRandom();
    const { message, signature } = await signDelegation(wallet);
    expect(recoverDelegationSigner(message, signature)?.toLowerCase()).toBe(
      wallet.address.toLowerCase(),
    );
    // buildDelegationTypedData returns the exact triple used to sign
    const td = buildDelegationTypedData(message);
    expect(td.domain).toBe(DELEGATION_DOMAIN);
  });

  it('returns null for a malformed signature (no throw)', () => {
    const wallet = Wallet.createRandom();
    const message: DelegationMessage = {
      delegator: wallet.address,
      agent: AGENT,
      maxUsdcPerTx: 100,
      maxUsdcTotal: 1000,
      expiry: 1,
      nonce: 1,
    };
    expect(recoverDelegationSigner(message, '0xdeadbeef')).toBeNull();
  });
});

// --- recordDelegation (ownership + signature) ------------------------------

describe('recordDelegation', () => {
  it('records a valid, owned, unexpired delegation', async () => {
    const wallet = Wallet.createRandom();
    mockOwnership(wallet.address);
    const { message, signature } = await signDelegation(wallet);
    const res = await recordDelegation({ agent: AGENT, message, signature });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('del-1');
  });

  it('rejects a bad signature', async () => {
    const wallet = Wallet.createRandom();
    mockOwnership(wallet.address);
    const { message } = await signDelegation(wallet);
    const res = await recordDelegation({ agent: AGENT, message, signature: '0x00' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('bad_signature');
  });

  it('rejects when the recovered signer != message.delegator (signer_mismatch)', async () => {
    const signer = Wallet.createRandom();
    const other = Wallet.createRandom();
    mockOwnership(other.address);
    // sign with `signer` but claim `other` is the delegator
    const { message } = await signDelegation(signer, { delegator: other.address });
    const signature = await signer.signTypedData(DELEGATION_DOMAIN, DELEGATION_TYPES, message);
    const res = await recordDelegation({ agent: AGENT, message, signature });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('signer_mismatch');
  });

  it('rejects when the signer does not own the agent (not_owner)', async () => {
    const wallet = Wallet.createRandom();
    const someoneElse = Wallet.createRandom();
    mockOwnership(someoneElse.address); // builder owns a DIFFERENT address
    const { message, signature } = await signDelegation(wallet);
    const res = await recordDelegation({ agent: AGENT, message, signature });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_owner');
  });

  it('rejects when the agent has no owner (agent_not_found)', async () => {
    const wallet = Wallet.createRandom();
    mockOwnership(null, { agentExists: false });
    const { message, signature } = await signDelegation(wallet);
    const res = await recordDelegation({ agent: AGENT, message, signature });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('agent_not_found');
  });

  it('rejects an already-expired delegation', async () => {
    const wallet = Wallet.createRandom();
    mockOwnership(wallet.address);
    const { message, signature } = await signDelegation(wallet, {
      expiry: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await recordDelegation({ agent: AGENT, message, signature });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('expired');
  });
});

// --- decideCoverage (pure scope/expiry/revocation logic) -------------------

describe('decideCoverage', () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();
  const live = (over: Partial<DelegationRow> = {}): DelegationRow => ({
    scope_json: { max_usdc_per_tx: 100, max_usdc_total: 1000 },
    expires_at: future,
    revoked_at: null,
    ...over,
  });

  it('allows an amount within per-tx and total', () => {
    expect(decideCoverage(50, [live()]).allowed).toBe(true);
  });

  it('rejects when no delegation exists', () => {
    expect(decideCoverage(50, [])).toEqual({ allowed: false, reason: 'no_delegation' });
  });

  it('rejects when all delegations are revoked', () => {
    expect(decideCoverage(50, [live({ revoked_at: past })]).reason).toBe('all_revoked');
  });

  it('rejects when all delegations are expired', () => {
    expect(decideCoverage(50, [live({ expires_at: past })]).reason).toBe('all_expired');
  });

  it('rejects an over-scope amount (exceeds per-tx)', () => {
    expect(decideCoverage(500, [live()]).reason).toBe('exceeds_per_tx');
  });

  it('rejects when cumulative spend would exceed max_usdc_total', () => {
    // per-tx 100 ok, but 980 already spent + 50 > 1000 total
    expect(decideCoverage(50, [live()], new Date(), 980).reason).toBe('exceeds_total');
  });
});

// --- assertDelegationCovers (enforcement hook + flag) ----------------------

describe('assertDelegationCovers enforcement hook', () => {
  it('is a no-op when DELEGATION_REQUIRED is OFF (default) — current behavior preserved', async () => {
    expect(delegationRequired()).toBe(false);
    const res = await assertDelegationCovers(AGENT, 999999);
    expect(res).toEqual({ allowed: true, enforced: false, reason: null });
    expect(mockedFrom).not.toHaveBeenCalled(); // no DB touched when flag OFF
  });

  it('when ON, allows if a valid delegation covers the amount', async () => {
    process.env['DELEGATION_REQUIRED'] = 'true';
    mockedFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        data: [
          {
            scope_json: { max_usdc_per_tx: 100, max_usdc_total: 1000 },
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            revoked_at: null,
          },
        ],
      }),
    }));
    const res = await assertDelegationCovers(AGENT, 50);
    expect(res).toEqual({ allowed: true, enforced: true, reason: null });
  });

  it('when ON, rejects if no delegation covers the amount', async () => {
    process.env['DELEGATION_REQUIRED'] = 'true';
    mockedFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ data: [] }),
    }));
    const res = await assertDelegationCovers(AGENT, 50);
    expect(res.allowed).toBe(false);
    expect(res.enforced).toBe(true);
    expect(res.reason).toBe('no_delegation');
  });

  it('when ON, rejects an over-scope amount even with a live delegation', async () => {
    process.env['DELEGATION_REQUIRED'] = 'true';
    mockedFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({
        data: [
          {
            scope_json: { max_usdc_per_tx: 100, max_usdc_total: 1000 },
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            revoked_at: null,
          },
        ],
      }),
    }));
    const res = await assertDelegationCovers(AGENT, 5000);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('exceeds_per_tx');
  });
});
