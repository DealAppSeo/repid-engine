/**
 * gate-account — a verified email becomes an account, without a password.
 *
 * Live numbers that motivated this: 73 builders, 70 token_only / 3 wallet /
 * ZERO auth_method='email'. The password signup path has never been used, while
 * people already type a 6-digit code for the run gate — a stronger proof of
 * inbox ownership, and one fewer field.
 *
 * Verified matrix:
 *   flag OFF        — inert; verifyOtp's response is byte-for-byte what it was
 *   flag ON         — creates a builder at the same starting RepID as the
 *                     password path, returns a usable full-account login token
 *   idempotent      — verifying twice returns the SAME account, creates nothing
 *   existing account— resolves by email, and by derived address when the email
 *                     column misses
 *   lost race       — insert fails on UNIQUE(address) → re-reads instead of
 *                     surfacing an error for a request that actually succeeded
 *   never blocking  — a provisioning failure must not cost the gate token
 *   token scopes    — a gate token is NOT accepted as a full-account token
 */

// ---------------------------------------------------------------------------
// db mock
// ---------------------------------------------------------------------------
interface DbState {
  selectResults: Record<string, Array<{ data: any; error: any }>>;
  inserts: Array<{ table: string; row: any }>;
  insertError: any;
  insertReturn: any;
}
const dbState: DbState = { selectResults: {}, inserts: [], insertError: null, insertReturn: null };

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
  q.insert = jest.fn((row: any) => {
    dbState.inserts.push({ table, row });
    const ret: any = {
      select: jest.fn(() => ret),
      single: jest.fn(async () =>
        dbState.insertError
          ? { data: null, error: dbState.insertError }
          : { data: dbState.insertReturn, error: null },
      ),
      maybeSingle: jest.fn(async () =>
        dbState.insertError
          ? { data: null, error: dbState.insertError }
          : { data: dbState.insertReturn, error: null },
      ),
      then: (resolve: any) =>
        resolve(dbState.insertError ? { data: null, error: dbState.insertError } : { data: null, error: null }),
    };
    return ret;
  });
  return q;
}

jest.mock('../src/db', () => ({
  db: { from: jest.fn((table: string) => makeQuery(table)) },
}));

jest.mock('../src/services/audit-emit', () => ({
  emitAuditEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

const EMAIL = 'newcomer@example.com';
const BUILDER_ID = 'builder-uuid-9';
const ORIGINAL_ENV = { ...process.env };

function loadGateAccount() {
  let mod: typeof import('../src/services/gate-account');
  jest.isolateModules(() => {
    mod = require('../src/services/gate-account');
  });
  return mod!;
}

/** Queue N consecutive "not found" reads on builders. */
function seedNoExisting(times = 2) {
  dbState.selectResults['builders'] = Array.from({ length: times }, () => ({ data: null, error: null }));
}

beforeEach(() => {
  dbState.selectResults = {};
  dbState.inserts = [];
  dbState.insertError = null;
  dbState.insertReturn = { id: BUILDER_ID, address: '0xEMAILdeadbeef' };
  process.env = { ...ORIGINAL_ENV };
  process.env.FULL_ACCOUNT_JWT_SECRET = 'test-jwt-secret';
  process.env.GATE_PROVISIONS_ACCOUNT = 'true';
  jest.clearAllMocks();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ===========================================================================
describe('flag discipline', () => {
  it('is inert by default — no flag, no account', async () => {
    delete process.env.GATE_PROVISIONS_ACCOUNT;
    const { GATE_PROVISIONS_ACCOUNT, provisionAccountFromVerifiedEmail } = loadGateAccount();
    expect(GATE_PROVISIONS_ACCOUNT).toBe(false);
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
    expect(dbState.inserts).toHaveLength(0);
  });

  it('is not switched on by a truthy-looking non-"true" value', async () => {
    process.env.GATE_PROVISIONS_ACCOUNT = '1';
    const { GATE_PROVISIONS_ACCOUNT } = loadGateAccount();
    expect(GATE_PROVISIONS_ACCOUNT).toBe(false);
  });
});

// ===========================================================================
describe('provisioning a new account', () => {
  it('creates a builder and returns a usable full-account token', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    seedNoExisting();
    const r = await provisionAccountFromVerifiedEmail(EMAIL);

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.builder_id).toBe(BUILDER_ID);

    const { verifyFullAccountToken } = require('../src/services/auth-token');
    const payload = verifyFullAccountToken(r.login_token);
    expect(payload).toEqual({ builder_id: BUILDER_ID, email: EMAIL });
  });

  it('writes no password_hash — the inbox is the credential', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    seedNoExisting();
    await provisionAccountFromVerifiedEmail(EMAIL);
    const row = dbState.inserts[0]!.row;
    expect(row.password_hash).toBeUndefined();
    expect(row.auth_method).toBe('email_otp');
  });

  it('starts at the SAME RepID as the password path — no new economic rule here', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    seedNoExisting();
    await provisionAccountFromVerifiedEmail(EMAIL);
    expect(dbState.inserts[0]!.row.current_repid).toBe(5000);
  });

  it('derives a stable address from the email, lowercased', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    const { deriveAddressFromEmail } = require('../src/services/full-account-signup');
    seedNoExisting();
    await provisionAccountFromVerifiedEmail(EMAIL.toUpperCase());
    expect(dbState.inserts[0]!.row.address).toBe(deriveAddressFromEmail(EMAIL).toLowerCase());
    expect(dbState.inserts[0]!.row.email).toBe(EMAIL);
  });

  it('rejects a non-email without touching the database', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    const r = await provisionAccountFromVerifiedEmail('not-an-email');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_email');
    expect(dbState.inserts).toHaveLength(0);
  });
});

// ===========================================================================
describe('idempotence — verifying twice must not mint a second account', () => {
  it('resolves an existing account by email and creates nothing', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    dbState.selectResults['builders'] = [
      { data: { id: BUILDER_ID, address: '0xEMAILexisting' }, error: null },
    ];
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.builder_id).toBe(BUILDER_ID);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('falls back to the derived address when the email column misses', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    dbState.selectResults['builders'] = [
      { data: null, error: null }, // by email: miss
      { data: { id: BUILDER_ID, address: '0xEMAILbyaddr' }, error: null }, // by address: hit
    ];
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('LOST RACE: insert hits UNIQUE(address) → re-reads instead of erroring', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    dbState.selectResults['builders'] = [
      { data: null, error: null }, // pre-check by email
      { data: null, error: null }, // pre-check by address
      { data: { id: BUILDER_ID, address: '0xEMAILraced' }, error: null }, // post-race by email
    ];
    dbState.insertError = { message: 'duplicate key value violates unique constraint "builders_address_key"' };

    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false);
    expect(r.builder_id).toBe(BUILDER_ID);
  });

  it('a genuine write failure with nothing to re-read still reports failure', async () => {
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    dbState.selectResults['builders'] = [
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    dbState.insertError = { message: 'connection refused' };
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('write_failed');
  });

  it('reports a missing JWT secret rather than returning an unusable token', async () => {
    delete process.env.FULL_ACCOUNT_JWT_SECRET;
    const { provisionAccountFromVerifiedEmail } = loadGateAccount();
    seedNoExisting();
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_jwt_secret');
  });
});

// ===========================================================================
describe('token scopes stay separate', () => {
  it('a gate token is NOT accepted as a full-account token', () => {
    // Both are HS256 over FULL_ACCOUNT_JWT_SECRET, so this is the property that
    // keeps "verified my email for free runs" from becoming "I own this account".
    const { issueAgentGateToken } = require('../src/services/email-otp');
    const { verifyFullAccountToken } = require('../src/services/auth-token');
    const gateToken = issueAgentGateToken(EMAIL);
    expect(gateToken).toBeTruthy();
    expect(verifyFullAccountToken(gateToken)).toBeNull();
  });

  it('a full-account token is NOT accepted as a gate token', () => {
    const { verifyAgentGateToken } = require('../src/services/email-otp');
    const { issueFullAccountToken } = require('../src/services/auth-token');
    const loginToken = issueFullAccountToken(BUILDER_ID, EMAIL);
    expect(verifyAgentGateToken(loginToken)).toBeNull();
  });
});
