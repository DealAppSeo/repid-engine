/**
 * ONE PROVER, PINNED (Sean, 2026-10-07). src/config/prover.ts holds the only prover host in src/.
 * A second deployment of the prover exists and nothing calls it; this test fails if any source file
 * names a prover host other than the pinned one, or names that second deployment at all.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PINNED_PROVER_URL, proverBaseUrl, proverAuthHeaders } from '../src/config/prover';

const ROOT = join(__dirname, '..');
const PROVER_HOST = /https?:\/\/[a-z0-9.-]*(?:zkp|prover|plonky|postcard|hyperdag-core)[a-z0-9.-]*/gi;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the engine calls one prover', () => {
  const files = sourceFiles(join(ROOT, 'src'));

  it('every prover host named in src/ is the pinned one, and only src/config/prover.ts names it', () => {
    const hits: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(PROVER_HOST)) hits.push(`${relative(ROOT, f)}: ${m[0]}`);
    }
    expect(hits).toEqual([`src/config/prover.ts: ${PINNED_PROVER_URL}`]);
  });

  it('the unused second deployment is named nowhere in src/', () => {
    const named = files.filter((f) => readFileSync(f, 'utf8').includes('hyperdag-core-production'));
    expect(named.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('every place that defaults the prover reads the pinned constant', () => {
    for (const f of [
      'src/scoring/pipeline.ts',
      'src/workers/proof-refresh-worker.ts',
      'src/scripts/start-proof-drain-service.ts',
      'src/routes/agents-external.ts',
    ]) expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(/from '\.\.\/config\/prover'/);
  });

  it('ZKP_SERVICE_URL still overrides per service; unset falls back to the pin', () => {
    expect(proverBaseUrl({} as NodeJS.ProcessEnv)).toBe(PINNED_PROVER_URL);
    expect(proverBaseUrl({ ZKP_SERVICE_URL: 'https://example.test' } as NodeJS.ProcessEnv)).toBe('https://example.test');
  });
});

describe('every prover call carries the bearer token (F-10, Sean 2026-10-07)', () => {
  const files = sourceFiles(join(ROOT, 'src'));
  // A request to the prover is a URL ending in one of its POST routes, built as a template
  // (`${base}/zkp/repid-proof`) or by concatenation (+ '/prove/trade_auth'). Comments are stripped
  // first: a route named in prose is not a call.
  const PROVER_CALL = /\/(?:zkp\/repid-proof|prove\/trade_auth)(?:`\s*[,)]|'\s*;)/;
  const code = (f: string) =>
    readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');

  it('the scan finds the call sites it is meant to guard', () => {
    const callers = files.filter((f) => PROVER_CALL.test(code(f)));
    expect(callers.length).toBeGreaterThanOrEqual(6);
  });

  it('every source file that calls the prover sends proverAuthHeaders()', () => {
    const missing = files
      .filter((f) => PROVER_CALL.test(code(f)))
      .filter((f) => {
        const src = code(f);
        const calls = (src.match(new RegExp(PROVER_CALL.source, 'g')) ?? []).length;
        const headers = (src.match(/\.\.\.proverAuthHeaders\(\)/g) ?? []).length;
        return headers < calls;
      })
      .map((f) => relative(ROOT, f));
    expect(missing).toEqual([]);
  });

  it('the header is a bearer token when ZKP_SERVICE_TOKEN is set, and absent when it is not', () => {
    expect(proverAuthHeaders({ ZKP_SERVICE_TOKEN: 'tok' } as NodeJS.ProcessEnv)).toEqual({ Authorization: 'Bearer tok' });
    expect(proverAuthHeaders({} as NodeJS.ProcessEnv)).toEqual({});
    expect(proverAuthHeaders({ ZKP_SERVICE_TOKEN: '   ' } as NodeJS.ProcessEnv)).toEqual({});
  });
});
