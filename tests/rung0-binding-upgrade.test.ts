/**
 * Rung 0 -> Rung 1 binding: upgrade the anonymous row, never mint a second one.
 *
 * Without this, verifying an email created a NEW builder and ORPHANED the anonymous one — the
 * visitor's builder_id silently changed and anything holding the old one pointed at a row
 * nobody would touch again. Preview-only makes that cheap (a Rung 0 row accrues no score) but
 * not correct.
 *
 * THE REFUSALS ARE THE INTERESTING HALF. Two proofs are required — possession of the session
 * token, and an OTP-verified email — and every way of having only one of them must fall back to
 * ordinary provisioning rather than taking over a row. Each of those paths is exercised here,
 * because an upgrade that cannot refuse is an account-takeover primitive.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.GATE_PROVISIONS_ACCOUNT = 'true';
process.env.FULL_ACCOUNT_JWT_SECRET = 'test-secret-for-binding';

/** Rows keyed by the lookup that finds them. Mutated by the stub's update(). */
let rows: any = {};
let updates: any[] = [];
let inserted: any[] = [];

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const state: any = { table, filters: {} };
    const api: any = {
      select: () => api,
      eq: (c: string, v: any) => { state.filters[c] = v; return api; },
      ilike: (c: string, v: any) => { state.filters[c] = String(v).toLowerCase(); return api; },
      is: (c: string, v: any) => { state.filters[`is_${c}`] = v; return api; },
      maybeSingle: async () => {
        if (state.filters.session_token) return { data: rows.byToken ?? null, error: null };
        if (state.filters.email) return { data: rows.byEmail ?? null, error: null };
        if (state.filters.address) return { data: rows.byAddress ?? null, error: null };
        return { data: null, error: null };
      },
      update: (patch: any) => {
        const u: any = { patch, filters: state.filters };
        return {
          eq: (c: string, v: any) => { u.filters = { ...u.filters, [c]: v }; return {
            is: () => { updates.push(u); return Promise.resolve({ data: null, error: rows.updateError ?? null }); },
            then: (r: any) => { updates.push(u); return r({ data: null, error: rows.updateError ?? null }); },
          }; },
        };
      },
      insert: (row: any) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: 'new-builder-id' }, error: null }) }) }; },
    };
    return api;
  };
  return { db: { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) } };
});
jest.mock('../src/services/audit-emit', () => ({ emitAuditEvent: jest.fn(async () => {}) }));

import { provisionAccountFromVerifiedEmail } from '../src/services/gate-account';

const TOKEN = 'a'.repeat(64);
const EMAIL = 'visitor@example.com';

beforeEach(() => { rows = {}; updates = []; inserted = []; });

describe('the upgrade happens in place', () => {
  it('keeps the SAME builder_id instead of creating a second row', async () => {
    rows.byToken = { id: 'rung0-id', address: '0xT0KENabc', email: null, auth_method: 'token_only' };
    const r = await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(r.ok).toBe(true);
    expect(r.builder_id).toBe('rung0-id');
    expect(r.created).toBe(false);
    expect(inserted).toHaveLength(0); // nothing was minted
  });

  it('keeps the 0xT0KEN address — the identifier this exists to preserve', async () => {
    rows.byToken = { id: 'rung0-id', address: '0xT0KENabc', email: null, auth_method: 'token_only' };
    const r = await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(r.builder_address).toBe('0xT0KENabc');
    expect(updates[0].patch.address).toBeUndefined(); // address is never rewritten
  });

  it('records the email and moves the row off token_only', async () => {
    rows.byToken = { id: 'rung0-id', address: '0xT0KENabc', email: null, auth_method: 'token_only' };
    await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(updates[0].patch.email).toBe(EMAIL);
    expect(updates[0].patch.auth_method).toBe('email_otp');
  });
});

describe('every refusal falls back, and none takes over a row', () => {
  it('a token that resolves to nothing does NOT block a verified email', async () => {
    rows.byToken = null;
    const r = await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(r.ok).toBe(true);
    expect(inserted).toHaveLength(1); // normal provisioning ran
  });

  it('REFUSES to re-bind a row that already carries an email', async () => {
    rows.byToken = { id: 'bound-id', address: '0xT0KENabc', email: 'someone@else.com', auth_method: 'token_only' };
    await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(updates).toHaveLength(0); // no update attempted — this would be takeover
  });

  it('REFUSES when the row is not token-only (never downgrade a real account)', async () => {
    rows.byToken = { id: 'full-id', address: '0xEMAILabc', email: null, auth_method: 'email_otp' };
    await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(updates).toHaveLength(0);
  });

  it("REFUSES when the email already belongs to a DIFFERENT builder", async () => {
    rows.byToken = { id: 'rung0-id', address: '0xT0KENabc', email: null, auth_method: 'token_only' };
    rows.byEmail = { id: 'someone-elses-id', address: '0xEMAILzzz' };
    await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    expect(updates).toHaveLength(0);
  });

  it('a failed update does not report success', async () => {
    rows.byToken = { id: 'rung0-id', address: '0xT0KENabc', email: null, auth_method: 'token_only' };
    rows.updateError = { message: 'conflict' };
    const r = await provisionAccountFromVerifiedEmail(EMAIL, { sessionToken: TOKEN });
    // falls through to normal provisioning rather than claiming an upgrade that did not happen
    expect(inserted).toHaveLength(1);
    expect(r.builder_id).not.toBe('rung0-id');
  });
});

describe('no token supplied — the ordinary path is untouched', () => {
  it('behaves exactly as before when no session token is passed', async () => {
    const r = await provisionAccountFromVerifiedEmail(EMAIL);
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(0);
    expect(inserted).toHaveLength(1);
  });
});
