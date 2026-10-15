/**
 * Call-site ratchet for pgQuery's write-once rule (XC1 on #1381).
 *
 * pgQuery refuses `retries > 1` on a statement that is not provably read-only unless the caller
 * says `idempotent: true`. That check runs at call time, so a call site on a path no test drives
 * would only find out in production. This reads every pgQuery call in src/ and scripts/ (plus
 * the eas anchor worker's injected `this.writeback`) and fails on any write that asks for
 * retries without the label. It also pins labels that must NOT be idempotent.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../src/services/operator-pager', () => ({ pageOperator: jest.fn(), pagerStatus: () => ({}) }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isReadOnlyStatement } = require('../src/db/direct-pg') as typeof import('../src/db/direct-pg');

const ROOT = path.join(__dirname, '..');
function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tsFiles(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
}

/** Every pgQuery(...) / this.writeback(...) call: its first literal SQL and its opts object text. */
function callSites(): Array<{ where: string; sql: string | null; opts: string }> {
  const out: Array<{ where: string; sql: string | null; opts: string }> = [];
  for (const file of [...tsFiles(path.join(ROOT, 'src')), ...tsFiles(path.join(ROOT, 'scripts'))]) {
    if (/[\\/]db[\\/]direct-pg\.ts$/.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const re = /\b(?:pgQuery|this\.writeback)(?:<[^>(]*>)?\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      let q: string | null = null;
      while (i < src.length && depth > 0) {
        const c = src[i]!;
        if (q) { if (c === '\\') i++; else if (c === q) q = null; }
        else if (c === '`' || c === "'" || c === '"') q = c;
        else if ('({['.includes(c)) depth++;
        else if (')}]'.includes(c)) depth--;
        i++;
      }
      const args = src.slice(m.index + m[0].length, i - 1).replace(/\/\/[^\n]*/g, '');
      const sqlM = args.match(/^\s*([`'"])([\s\S]*?)\1/);
      const optsM = args.match(/\{[^{}]*\}\s*,?\s*$/);
      out.push({
        where: `${path.relative(ROOT, file).replace(/\\/g, '/')}:${src.slice(0, m.index).split('\n').length}`,
        sql: sqlM ? sqlM[2]!.replace(/\$\{[^}]*\}/g, ' X ') : null,
        opts: optsM ? optsM[0] : '',
      });
    }
  }
  return out;
}

test('the scan sees the call sites (guards against the ratchet silently matching nothing)', () => {
  const sites = callSites();
  expect(sites.length).toBeGreaterThan(50);
  expect(sites.some((s) => s.where.startsWith('scripts/run-repid-decay.ts'))).toBe(true);
  expect(sites.some((s) => s.where.startsWith('src/workers/eas-anchor-worker.ts') && /writeback-uid/.test(s.opts))).toBe(true);
});

test('no write asks for retries > 1 without idempotent: true', () => {
  const offenders = callSites()
    .filter((s) => {
      const n = Number(/\bretries:\s*(\d+)/.exec(s.opts)?.[1] ?? 1);
      return n > 1 && s.sql !== null && !isReadOnlyStatement(s.sql) && !/\bidempotent:\s*true\b/.test(s.opts);
    })
    .map((s) => `${s.where} ${s.opts.replace(/\s+/g, ' ')}`);
  expect(offenders).toEqual([]);
});

test('the eas writeback is idempotent by construction: a replay returns the rows THIS uid stamped', () => {
  const site = callSites().find((s) => /eas-anchor-writeback-uid/.test(s.opts))!;
  expect(site.sql).toMatch(/AND \(eas_attestation_uid IS NULL OR eas_attestation_uid = \$1\)/);
  expect(site.opts).toMatch(/idempotent:\s*true/);
});

test('labels that must NOT claim idempotency', () => {
  // Can never insert (42P10 / 23514): the label only bought five backed-off attempts at a deterministic error.
  const site = callSites().find((s) => /peer-verify-score-insert/.test(s.opts))!;
  expect(site).toBeDefined();
  expect(site.opts).not.toMatch(/idempotent/);
});
