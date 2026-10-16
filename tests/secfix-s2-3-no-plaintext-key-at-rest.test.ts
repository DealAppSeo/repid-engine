/**
 * [S2-3, 2026-10-16] No API key is stored in plaintext, and the app runs no DDL at runtime.
 *
 * versioningMiddleware upserted `req.apiKey.key` into api_key_versions, so the table held 169
 * live-shaped plaintext keys (r32). It now stores a non-secret caller handle. Four call sites ran
 * `CREATE TABLE IF NOT EXISTS` through the SECURITY DEFINER `run_sql` RPC; they are gone.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const upserts: Array<Record<string, unknown>> = [];
const rpc = jest.fn(async () => ({ data: null, error: null }));
jest.mock('../src/db', () => ({
  db: {
    rpc: (...a: unknown[]) => (rpc as any)(...a),
    from: () => ({ upsert: async (row: Record<string, unknown>) => { upserts.push(row); return { error: null }; } }),
  },
}));

import { versioningMiddleware, _resetVersionCache } from '../src/middleware/versioning';

const RAW = 'ts_live_0123456789abcdef0123456789abcdef';

async function run(req: any): Promise<void> {
  const next = jest.fn();
  await versioningMiddleware({ headers: {}, ...req } as any, {} as any, next);
  expect(next).toHaveBeenCalledTimes(1);
}

beforeEach(() => { upserts.length = 0; rpc.mockClear(); _resetVersionCache(); });

describe('api_key_versions never receives a key', () => {
  it('an agent-bound key is stored as agent:<id>', async () => {
    await run({ apiKey: { key: RAW, tier: 'testnet' }, agent_id: 'aaaaaaaa-1111-2222-3333-444444444444' });
    expect(upserts[0].api_key).toBe('agent:aaaaaaaa-1111-2222-3333-444444444444');
    expect(JSON.stringify(upserts)).not.toContain(RAW);
  });

  it('an env operator key is stored as env:<index>', async () => {
    await run({ apiKey: { key: 'some-operator-secret', tier: 'ops', envIndex: 2 } });
    expect(upserts[0].api_key).toBe('env:2');
    expect(JSON.stringify(upserts)).not.toContain('some-operator-secret');
  });

  it('no key → anonymous', async () => {
    await run({});
    expect(upserts[0].api_key).toBe('anonymous');
  });

  it('runs no DDL', async () => {
    await run({ apiKey: { key: RAW, tier: 'testnet' }, agent_id: 'x' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('no runtime DDL through run_sql / exec_sql anywhere in src/', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js)$/.test(f) && !p.endsWith('database.types.ts')) files.push(p);
    }
  };
  walk(join(__dirname, '../src'));

  it('no file calls rpc(run_sql|exec_sql)', () => {
    const hits = files.filter((f) => /\.rpc\(\s*['"`](run_sql|exec_sql)['"`]/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
