/**
 * C8 A1 — resolver is in exactly one module.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('C8 A1 — one resolver', () => {
  it('export function resolveGrounding lives in exactly one src file', () => {
    const files = walk(join(process.cwd(), 'src')).filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /export async function resolveGrounding\b/.test(t);
    });
    expect(files.map((f) => f.replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/src\/scoring\/grounding\.ts$/)]),
    );
    expect(files).toHaveLength(1);
  });
});
