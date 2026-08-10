/**
 * PUBLIC-INPUT FENCE for the keyless /api/v1/repid/* routes.
 *
 * THE BUG, proven against the live database before it was fixed. `resolveAgentUuid()` exists
 * precisely so a slug never reaches a uuid-typed column — the `/proof` route says so in a
 * comment. But three sibling routes (`/repid/:id`, `/repid/:id/history`, `/repid/:id/zkp`)
 * each carried their own COPY of the resolution logic, and the copies diverged in the case
 * that matters: when the name lookup missed, they kept the caller's raw string and passed it
 * straight through.
 *
 * Postgres answers that with 22P02:
 *
 *     invalid input syntax for type uuid: "trinity-does-not-exist"
 *
 * …verified directly against the production database. `/history` then returned that text to
 * an UNAUTHENTICATED caller as a 500. So any stranger with curl could trigger a 500 and read
 * back an internal column type plus their own probe. The fix for `/proof` had been in the
 * tree for weeks; its siblings kept the copy and kept the bug.
 *
 * TWO PROPERTIES, both regression-tested here:
 *   1. An unresolvable agent id is a 404, never a 500 — the raw string never reaches the DB.
 *   2. No public error body carries upstream error text. It is logged, not served.
 *
 * The db module is mocked, so this needs no credentials and no network: it exercises the
 * ROUTE logic, which is where the bug lived.
 */
import express from 'express';
import request from 'supertest';

/** Records every table/filter the routes attempt, so we can assert what reached the DB. */
const attempted: Array<{ table: string; filters: Array<[string, unknown]> }> = [];

jest.mock('../src/db', () => {
  const makeQuery = (table: string) => {
    const rec: { table: string; filters: Array<[string, unknown]> } = { table, filters: [] };
    attempted.push(rec);
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => { rec.filters.push([col, val]); return q; },
      order: () => q,
      limit: () => q,
      not: () => q,
      // No agent matches anything — the "unresolvable slug" case.
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return q;
  };
  return { db: { from: (table: string) => makeQuery(table) } };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { repidPublicRouter } = require('../src/routes/repid');

const app = express();
app.use('/api/v1', repidPublicRouter);

const HOSTILE_IDS = [
  'trinity-does-not-exist',
  'nope',
  '00000000-0000-0000-0000-00000000000Z',
  "' OR 1=1--",
  '../../etc/passwd',
  'a'.repeat(500),
  '%00',
  'VETO‮DEVORPPA',
];

const PATHS = ['', '/history', '/zkp'] as const;

describe('an unresolvable agent id is a 404, never a 500', () => {
  beforeEach(() => { attempted.length = 0; });

  for (const suffix of PATHS) {
    test.each(HOSTILE_IDS)(`GET /repid/:id${suffix || ''} with %j`, async (id) => {
      const res = await request(app).get(`/api/v1/repid/${encodeURIComponent(id)}${suffix}`);
      // 404 is the contract. A 500 here means the raw string reached a uuid column again.
      expect(`${suffix || '/'} ${id} -> ${res.status}`).toBe(`${suffix || '/'} ${id} -> 404`);
    });
  }

  test('the raw slug is never used as a uuid filter — only for the name lookup', async () => {
    await request(app).get('/api/v1/repid/trinity-does-not-exist/history');
    // The only place the raw string may appear is the agent_name/token lookup on repid_agents.
    for (const a of attempted) {
      for (const [col, val] of a.filters) {
        if (val === 'trinity-does-not-exist' || String(val).includes('does-not-exist')) {
          expect(`${a.table}.${col}`).toMatch(/repid_agents\.(agent_name|erc8004_token_id)/);
        }
      }
    }
  });
});

describe('public error bodies do not carry upstream error text', () => {
  test.each(PATHS)('GET /repid/:id%s leaks no detail field', async (suffix) => {
    const res = await request(app).get(`/api/v1/repid/trinity-does-not-exist${suffix}`);
    expect(res.body).toBeDefined();
    // A stable code is fine. Anything resembling upstream prose is not.
    expect(Object.keys(res.body)).not.toContain('detail');
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/invalid input syntax|uuid|postgres|relation|column/i);
  });
});

describe('the resolution logic exists in exactly one place', () => {
  // The bug was duplication, not the individual routes. If a fourth copy appears, the fix
  // will drift out of it exactly as it drifted out of these three.
  test('no route reimplements the slug -> uuid dance inline', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const path = require('node:path');
    const src = readFileSync(path.resolve(__dirname, '../src/routes/repid.ts'), 'utf8');
    const copies = (src.match(/lcName\.startsWith\('trinity-'\)/g) ?? []).length;
    expect(`inline copies: ${copies}`).toBe('inline copies: 1');
  });
});
