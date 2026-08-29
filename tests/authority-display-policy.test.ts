/**
 * A TOKEN-ONLY BUILDER WAS BEING QUOTED AN AUTHORITY CEILING THAT DOES NOT EXIST.
 *
 * `computeAuthority` gives a `token_only` builder a real figure off the demo formula, and that
 * figure is honest about what it computed. But the gate that actually hands out spend budgets is
 * `A_eff` (`effective-authority.ts`), which applies its builder floor unconditionally and would
 * refuse. So the stake page quoted a ceiling nothing downstream would honour — an overpromise to
 * the reader, not an arithmetic bug.
 *
 * THE SEAM IS THE POINT OF THIS FILE. A policy that is correct in its own module and dropped on
 * the way to the caller is the failure this project shipped once already today: a field computed,
 * typed, returned, unit-tested — and silently discarded by a hand-copied projection one layer up.
 * So the route is driven end to end, not just the decision function.
 *
 * `withheld` matters as much as `authority: null`, because a caller that cannot tell "no figure"
 * from "zero" will render $0.00 and state something false in the other direction.
 */
import express from 'express';
import request from 'supertest';
import {
  decideAuthorityDisplay,
  resolveDemoAuthorityDisplay,
  DEMO_AUTHORITY_DISPLAY_DEFAULT,
} from '../src/config/display-policy';

describe('decideAuthorityDisplay — the decision itself', () => {
  it('PASSED is untouched and binding: a real floor ran and said yes', () => {
    const d = decideAuthorityDisplay('50000000', 'PASSED');
    expect(d).toEqual({ authority: '50000000', withheld: false, binding: true });
  });

  it('FAILED is untouched too — a measured zero is a result the caller may show', () => {
    const d = decideAuthorityDisplay('0', 'FAILED');
    expect(d.authority).toBe('0');
    expect(d.withheld).toBe(false);
    expect(d.binding).toBe(true);
  });

  it('NOT_APPLIED withholds the number by default, and says it is not zero', () => {
    const d = decideAuthorityDisplay('50000000', 'NOT_APPLIED');
    expect(d.authority).toBeNull();
    expect(d.withheld).toBe(true);
    expect(d.binding).toBe(false);
    expect(d.detail).toMatch(/not zero/i);
  });

  it("'labelled' shows the figure but never calls it binding", () => {
    const d = decideAuthorityDisplay('50000000', 'NOT_APPLIED', 'labelled');
    expect(d.authority).toBe('50000000');
    expect(d.withheld).toBe(false);
    expect(d.binding).toBe(false);
    expect(d.detail).toBeTruthy();
  });

  it("'raw' restores the old behaviour — still not binding, because it never was", () => {
    const d = decideAuthorityDisplay('50000000', 'NOT_APPLIED', 'raw');
    expect(d.authority).toBe('50000000');
    expect(d.binding).toBe(false);
  });
});

describe('resolveDemoAuthorityDisplay — the three levels', () => {
  const saved = process.env['DEMO_AUTHORITY_DISPLAY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['DEMO_AUTHORITY_DISPLAY'];
    else process.env['DEMO_AUTHORITY_DISPLAY'] = saved;
  });

  it('defaults to hidden when nothing is set anywhere', () => {
    delete process.env['DEMO_AUTHORITY_DISPLAY'];
    expect(resolveDemoAuthorityDisplay()).toBe('hidden');
    expect(DEMO_AUTHORITY_DISPLAY_DEFAULT).toBe('hidden');
  });

  it('the deployment env overrides the default', () => {
    process.env['DEMO_AUTHORITY_DISPLAY'] = 'raw';
    expect(resolveDemoAuthorityDisplay()).toBe('raw');
  });

  it('a caller override beats the env — this is where a user setting will plug in', () => {
    process.env['DEMO_AUTHORITY_DISPLAY'] = 'raw';
    expect(resolveDemoAuthorityDisplay('hidden')).toBe('hidden');
  });

  it('A TYPO FALLS BACK TO THE DEFAULT, NOT TO raw', () => {
    // The direction is the whole point: "unknown means leave it alone" would silently restore
    // the overpromising behaviour on a misspelled variable.
    process.env['DEMO_AUTHORITY_DISPLAY'] = 'hiden';
    expect(resolveDemoAuthorityDisplay()).toBe('hidden');
    process.env['DEMO_AUTHORITY_DISPLAY'] = '';
    expect(resolveDemoAuthorityDisplay()).toBe('hidden');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveDemoAuthorityDisplay('  LABELLED ')).toBe('labelled');
  });
});

/**
 * THE SEAM. Everything above proves the decision function is right. None of it proves the route
 * uses it — which is exactly the gap that let a correct, typed, unit-tested field get dropped by
 * a hand-copied projection earlier today. So this drives the real handler over HTTP.
 *
 * The db is stubbed: booting the real app would reach production Supabase and start a cascade
 * worker on a timer. A route test must never be able to move money.
 */
describe('GET /stake/authority/:builder_id — the value actually reaching a caller', () => {
  const mkApp = (authMethod: string, builderRepId: number) => {
    jest.resetModules();
    const rows: Record<string, any> = {
      builders: { id: 'b1', auth_method: authMethod, current_repid: builderRepId },
    };
    const makeQuery = (name: string) => {
      const q: any = {
        select: () => q, eq: () => q, in: () => q, gte: () => q, order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: rows[name] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows[name] ?? null, error: null }),
        insert: () => Promise.resolve({ data: null, error: null }),
        then: (r: any) =>
          Promise.resolve({ data: name === 'builders' ? [rows['builders']] : [], error: null }).then(r),
      };
      return q;
    };
    jest.doMock('../src/db', () => ({ db: { from: (t: string) => makeQuery(t) } }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../src/routes/v1').default;
    const app = express();
    app.use('/api/v1', router);
    return app;
  };

  it('a token_only builder gets NO number, and is told it is not zero', async () => {
    const res = await request(mkApp('token_only', 0)).get('/api/v1/stake/authority/b1');
    expect(res.status).toBe(200);
    expect(res.body.authority).toBeNull();
    expect(res.body.authority_withheld).toBe(true);
    expect(res.body.authority_is_binding).toBe(false);
    expect(res.body.authority_detail).toMatch(/not zero/i);
    // The audit trail is NOT redacted — the snapshot basis still carries what was computed.
    expect(res.body.basis.floor_check).toBe('NOT_APPLIED');
  });

  it('a normal builder above the floor still gets its number, marked binding', async () => {
    const res = await request(mkApp('email_otp', 3000)).get('/api/v1/stake/authority/b1');
    expect(res.status).toBe(200);
    expect(res.body.authority_withheld).toBe(false);
    expect(res.body.authority_is_binding).toBe(true);
    expect(res.body.basis.floor_check).toBe('PASSED');
    expect(typeof res.body.authority).toBe('string');
  });
});
