/**
 * Every `x-` header the engine reads is classified: a browser may send it, or it is server-only.
 * See src/config/cors-headers.ts for the three production breakages an unclassified list caused.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { BROWSER_HEADERS, CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, SERVER_ONLY_HEADERS } from '../src/config/cors-headers';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

// Case-insensitive: Express lower-cases names, but code spells them X-Cron-Token and so on.
const READ = /headers\[['"](x-[a-z0-9-]+)['"]\]|header\(['"](x-[a-z0-9-]+)['"]\)|headers\.get\(['"](x-[a-z0-9-]+)['"]\)|_HEADER = ['"](x-[a-z0-9-]+)['"]/gi;

it('finds the headers it is meant to find (the scan itself works)', () => {
  const seen = new Set<string>();
  for (const f of files(join(__dirname, '..', 'src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(READ)) seen.add((m[1] ?? m[2] ?? m[3] ?? m[4])!.toLowerCase());
  }
  // If these disappear the regex broke, and a green run below would mean nothing.
  for (const h of ['x-hd-wallet', 'x-agent-key', 'x-agent-gate-token', 'x-api-key']) expect(seen).toContain(h);

  const classified = new Set([...BROWSER_HEADERS, ...SERVER_ONLY_HEADERS].map((h) => h.toLowerCase()));
  const unclassified = [...seen].filter((h) => !classified.has(h));
  expect(unclassified).toEqual([]);
});

it('no header is both browser and server-only', () => {
  const server = new Set(SERVER_ONLY_HEADERS.map((h) => h.toLowerCase()));
  expect(BROWSER_HEADERS.filter((h) => server.has(h.toLowerCase()))).toEqual([]);
});

it('the headers trustshell.dev sends from the browser are allowed, and the run counter is readable', () => {
  const allowed = CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase());
  for (const h of ['x-hd-wallet', 'x-hd-timestamp', 'x-hd-signature', 'x-agent-key', 'x-agent-gate-token', 'x-api-key', 'content-type']) {
    expect(allowed).toContain(h);
  }
  expect(CORS_EXPOSED_HEADERS).toContain('x-taste-remaining');
});

it('src/index.ts actually uses these lists', () => {
  const index = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  expect(index).toMatch(/allowedHeaders:\s*CORS_ALLOWED_HEADERS/);
  expect(index).toMatch(/exposedHeaders:\s*CORS_EXPOSED_HEADERS/);
});
