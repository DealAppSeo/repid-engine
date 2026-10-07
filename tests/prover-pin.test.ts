/**
 * ONE PROVER, PINNED (Sean, 2026-10-07). src/config/prover.ts holds the only prover host in src/.
 * A second deployment of the prover exists and nothing calls it; this test fails if any source file
 * names a prover host other than the pinned one, or names that second deployment at all.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PINNED_PROVER_URL, proverBaseUrl } from '../src/config/prover';

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
