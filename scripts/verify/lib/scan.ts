/**
 * Cross-repo source scanner — shared by verify:claims and the swarm-throughput check.
 *
 * A mechanism a claim/check cares about may live in a different repo than the one we run in
 * (e.g. the swarm's atomic `claimed_by` claim + parallel spawn are in trinity-symphony-shared,
 * NOT repid-engine). Scanning only `<cwd>/src` is the blind spot that made the harness
 * false-flag GA's swarm concurrency as phantom. So scan repid-engine `src/` AND sibling repos,
 * `.ts`+`.js`. Override roots with VERIFY_SCAN_DIRS (comma-separated, abs or relative to cwd).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

export function scanRoots(): string[] {
  const override = (process.env.VERIFY_SCAN_DIRS ?? process.env.VERIFY_CLAIMS_SCAN_DIRS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const defaults = [join(process.cwd(), 'src'), join(process.cwd(), '..', 'trinity-symphony-shared')];
  const roots = override.length
    ? override.map(d => (d.match(/^([a-zA-Z]:[\\/]|[\\/])/) ? d : join(process.cwd(), d)))
    : defaults;
  return roots.filter(d => existsSync(d));
}

export function scanRootLabels(): string[] {
  return scanRoots().map(r => r.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? r);
}

/** Return `<repo>:<relpath>` of the first file matching `re` across all scan roots, else null. */
export function scanRepos(re: RegExp): string | null {
  for (const root of scanRoots()) {
    const repo = root.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).slice(-2).join('/');
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: string[]; try { entries = readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        if (e === 'node_modules' || e === '.git' || e === 'dist' || e === '.next') continue;
        const p = join(dir, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { stack.push(p); continue; }
        if (!/\.(ts|js|tsx|mjs)$/.test(e)) continue;
        let body: string; try { body = readFileSync(p, 'utf8'); } catch { continue; }
        if (re.test(body)) return `${repo}:${p.replace(root, '').replace(/^[\\/]/, '').replace(/\\/g, '/')}`;
      }
    }
  }
  return null;
}
