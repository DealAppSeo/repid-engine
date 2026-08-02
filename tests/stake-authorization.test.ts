/**
 * stake-authorization — who may credit a stake deposit.
 *
 * The hole: POST /api/v1/stake/deposit was on the global auth bypass list and
 * read `builder_address` from the body, so anyone could credit stake — and
 * therefore authority — to an account they do not control.
 *
 * Verified matrix:
 *   simulated stake — rejected with no credential / bad session / someone else's
 *                     account; accepted for a matching session or operator key
 *   real stake      — ALWAYS needs a wallet signature, even with a valid session
 *                     for that same account
 *   signature       — must be over this wallet, this amount and this tx hash;
 *                     a signature captured for one deposit cannot be replayed
 *                     for another amount, another tx, or another account
 *   rollback valve  — STAKE_DEPOSIT_AUTH_ENFORCED=false lets a call through and
 *                     says so loudly
 */

import { Wallet } from 'ethers';

// ---------------------------------------------------------------------------
// db mock — same chainable shape as reponomics-real-staking.test.ts
// ---------------------------------------------------------------------------
interface DbState {
  selectResults: Record<string, Array<{ data: any; error: any }>>;
}
const dbState: DbState = { selectResults: {} };

function makeQuery(table: string) {
  const q: any = {};
  const chain = () => q;
  for (const m of ['select', 'eq', 'ilike', 'limit', 'order', 'in', 'gte', 'is']) {
    q[m] = jest.fn(chain);
  }
  const pull = () => {
    const queue = dbState.selectResults[table] ?? [];
    return queue.length ? queue.shift() : { data: null, error: null };
  };
  q.maybeSingle = jest.fn(async () => pull());
  q.single = jest.fn(async () => pull());
  q.then = (resolve: any) => resolve(pull());
  return q;
}

jest.mock('../src/db', () => ({
  db: { from: jest.fn((table: string) => makeQuery(table)) },
}));

// ---------------------------------------------------------------------------
// Fixtures. A real key so signatures are genuinely recovered, not stubbed —
// the whole control is "does this recover to that address".
// ---------------------------------------------------------------------------
const OWNER = new Wallet('0x'.padEnd(66, '1'));
const STRANGER = new Wallet('0x'.padEnd(66, '2'));
const BUILDER_ID = 'builder-uuid-1';
const OTHER_BUILDER_ID = 'builder-uuid-2';
const AMOUNT = '100000000'; // 100 USDC, 6dp
const TX = '0x' + 'a'.repeat(64);
const OPERATOR_KEY = 'operator-secret-key';

const ORIGINAL_ENV = { ...process.env };

function seedBuilder(id = BUILDER_ID, address = OWNER.address) {
  dbState.selectResults['builders'] = [{ data: { id, address }, error: null }];
}
function seedNoBuilder() {
  dbState.selectResults['builders'] = [{ data: null, error: null }];
}

/** Load the module fresh so module-level env reads (the enforce flag) re-evaluate. */
function loadModule() {
  let mod: typeof import('../src/services/stake-authorization');
  jest.isolateModules(() => {
    mod = require('../src/services/stake-authorization');
  });
  return mod!;
}

/** A valid session token for a builder, minted with the real signer. */
function sessionFor(builderId: string): string {
  const { issueFullAccountToken } = require('../src/services/auth-token');
  return issueFullAccountToken(builderId, 'owner@example.com');
}

beforeEach(() => {
  dbState.selectResults = {};
  process.env = { ...ORIGINAL_ENV };
  process.env.FULL_ACCOUNT_JWT_SECRET = 'test-jwt-secret';
  process.env.REPID_API_KEYS = `${OPERATOR_KEY}:enterprise`;
  delete process.env.STAKE_DEPOSIT_AUTH_ENFORCED;
  jest.clearAllMocks();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ===========================================================================
describe('stakeDepositMessage — what the user actually signs', () => {
  it('binds the wallet, the amount and the tx hash into the text', () => {
    const { stakeDepositMessage } = loadModule();
    const msg = stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX });
    expect(msg).toContain(OWNER.address.toLowerCase());
    expect(msg).toContain(AMOUNT);
    expect(msg).toContain(TX);
    // It must be honest about what signing does — this text is shown in a wallet.
    expect(msg).toContain('moves no funds');
  });

  it('is case-stable, so a checksummed address and a lowercase one sign the same text', () => {
    const { stakeDepositMessage } = loadModule();
    const a = stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX });
    const b = stakeDepositMessage({
      wallet: OWNER.address.toLowerCase(),
      amount: AMOUNT,
      txHash: TX.toUpperCase(),
    });
    expect(a).toBe(b);
  });
});

// ===========================================================================
describe('simulated stake — session or operator, never anonymous', () => {
  it('rejects an anonymous deposit (the hole this closes)', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder();
    const r = await authorizeStakeDeposit({ builderAddress: OWNER.address, amount: AMOUNT });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_credential');
  });

  it('rejects an invalid / expired session', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder();
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      authorizationHeader: 'Bearer not-a-real-token',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_session');
  });

  it("rejects a valid session for somebody ELSE's account", async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder(BUILDER_ID);
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      authorizationHeader: `Bearer ${sessionFor(OTHER_BUILDER_ID)}`,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_your_account');
  });

  it('accepts the account holder — zero extra friction for someone signed in', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder(BUILDER_ID);
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      authorizationHeader: `Bearer ${sessionFor(BUILDER_ID)}`,
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('session');
    expect(r.builderId).toBe(BUILDER_ID);
  });

  it('accepts an operator key from the env allowlist (harness path)', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder();
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      apiKeyHeader: OPERATOR_KEY,
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('operator');
  });

  it('404s an address with no account rather than leaking a different error', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedNoBuilder();
    const r = await authorizeStakeDeposit({
      builderAddress: STRANGER.address,
      amount: AMOUNT,
      authorizationHeader: `Bearer ${sessionFor(BUILDER_ID)}`,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('account_not_found');
  });
});

// ===========================================================================
describe('real stake — a wallet signature, always', () => {
  it('refuses a real deposit with no signature EVEN with a valid session', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder(BUILDER_ID);
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: TX,
      authorizationHeader: `Bearer ${sessionFor(BUILDER_ID)}`,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('signature_required');
  });

  it('accepts a correct signature over this exact deposit', async () => {
    const { authorizeStakeDeposit, stakeDepositMessage } = loadModule();
    seedBuilder(BUILDER_ID);
    const signature = await OWNER.signMessage(
      stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX }),
    );
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: TX,
      signature,
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('wallet_signature');
    expect(r.builderId).toBe(BUILDER_ID);
  });

  it('rejects a signature from a different wallet', async () => {
    const { authorizeStakeDeposit, stakeDepositMessage } = loadModule();
    seedBuilder(BUILDER_ID);
    const signature = await STRANGER.signMessage(
      stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX }),
    );
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: TX,
      signature,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it('REPLAY: a signature for one tx cannot credit a different tx', async () => {
    const { authorizeStakeDeposit, stakeDepositMessage } = loadModule();
    seedBuilder(BUILDER_ID);
    const signature = await OWNER.signMessage(
      stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX }),
    );
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: '0x' + 'b'.repeat(64), // a different deposit
      signature,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it('REPLAY: a signature for one amount cannot credit a larger one', async () => {
    const { authorizeStakeDeposit, stakeDepositMessage } = loadModule();
    seedBuilder(BUILDER_ID);
    const signature = await OWNER.signMessage(
      stakeDepositMessage({ wallet: OWNER.address, amount: AMOUNT, txHash: TX }),
    );
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: '999000000', // inflated
      txHash: TX,
      signature,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it('rejects garbage in the signature field without throwing', async () => {
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder(BUILDER_ID);
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: TX,
      signature: 'not-a-signature',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_signature');
  });

  it("treats a 'simulated:' tx_hash as simulated, not as a real deposit claim", async () => {
    const { authorizeStakeDeposit, isRealDepositClaim } = loadModule();
    expect(isRealDepositClaim('simulated:abc')).toBe(false);
    expect(isRealDepositClaim(TX)).toBe(true);
    seedBuilder(BUILDER_ID);
    // ...so it takes the session path, not the signature path.
    const r = await authorizeStakeDeposit({
      builderAddress: OWNER.address,
      amount: AMOUNT,
      txHash: 'simulated:abc',
      authorizationHeader: `Bearer ${sessionFor(BUILDER_ID)}`,
    });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('session');
  });
});

// ===========================================================================
describe('rollback valve — off is loud', () => {
  it('lets a call through when disabled, and warns every time', async () => {
    process.env.STAKE_DEPOSIT_AUTH_ENFORCED = 'false';
    const { authorizeStakeDeposit } = loadModule();
    seedBuilder();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await authorizeStakeDeposit({ builderAddress: OWNER.address, amount: AMOUNT });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('unenforced');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('STAKE_DEPOSIT_AUTH_ENFORCED=false'));
    warn.mockRestore();
  });

  it('defaults to ENFORCED when the env var is absent', async () => {
    delete process.env.STAKE_DEPOSIT_AUTH_ENFORCED;
    const { STAKE_DEPOSIT_AUTH_ENFORCED, authorizeStakeDeposit } = loadModule();
    expect(STAKE_DEPOSIT_AUTH_ENFORCED).toBe(true);
    seedBuilder();
    const r = await authorizeStakeDeposit({ builderAddress: OWNER.address, amount: AMOUNT });
    expect(r.ok).toBe(false);
  });

  it('is not switched off by an unrelated value', async () => {
    process.env.STAKE_DEPOSIT_AUTH_ENFORCED = 'yes';
    const { STAKE_DEPOSIT_AUTH_ENFORCED } = loadModule();
    expect(STAKE_DEPOSIT_AUTH_ENFORCED).toBe(true);
  });
});
