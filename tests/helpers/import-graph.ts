/**
 * import-graph.ts — can a live entrypoint reach a module? Shared by the shadow isolation tests
 * (antifarming-eligibility, repid-uncertainty). Moved verbatim out of
 * tests/antifarming-eligibility.test.ts so both tests use ONE walker: two copies of a checker drift.
 *
 * Entrypoints are DISCOVERED from what the deploy configs actually run (railway*.json,
 * Dockerfile*, package.json start/indexer/worker), not listed. Every caller must also run the
 * positive controls (the walker reaches repid-update.ts; the reference scan finds a name it is
 * pointed at): a walker that matches nothing passes every absence check.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

export const ROOT = resolve(__dirname, '..', '..');

const read = (f: string) => readFileSync(f, 'utf8');

/** Live entrypoints, discovered from what the deploy configs actually run. */
export function discoverEntrypoints(): string[] {
  const commands: string[] = [];
  for (const f of readdirSync(ROOT)) {
    if (/^railway.*\.json$/.test(f)) commands.push(String(JSON.parse(read(join(ROOT, f)))?.deploy?.startCommand ?? ''));
    if (/^Dockerfile/.test(f)) for (const m of read(join(ROOT, f)).matchAll(/^CMD\s+\[(.+)\]/gm)) commands.push(String(m[1]).replace(/[",]/g, ' '));
  }
  const scripts = JSON.parse(read(join(ROOT, 'package.json'))).scripts as Record<string, string>;
  for (const k of ['start', 'indexer', 'worker']) if (scripts[k]) commands.push(scripts[k]);
  const files = new Set<string>();
  for (const cmd of commands) {
    for (const tok of cmd.split(/\s+/)) {
      if (!/\.(m?js|ts)$/.test(tok)) continue;
      const src = tok.startsWith('dist/') ? tok.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts') : tok;
      files.add(join(ROOT, src));
    }
  }
  return [...files];
}

const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every local module reachable from `entry` through import / export-from / import() / require(). */
export function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of read(file).matchAll(SPEC_RE)) {
      const base = resolve(dirname(file), String(m[1]));
      const noJs = base.replace(/\.(m?js)$/, '');
      for (const cand of [base, `${base}.ts`, `${noJs}.ts`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')]) {
        if (existsSync(cand) && statSync(cand).isFile()) { queue.push(cand); break; }
      }
    }
  }
  return seen;
}

/** Files under `dirs` that mention `needle` (a module path fragment). */
export function referencesTo(needle: string, dirs: string[]): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs|cjs)$/.test(name) && read(p).includes(needle)) hits.push(relative(ROOT, p).replace(/\\/g, '/'));
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return hits.sort();
}
