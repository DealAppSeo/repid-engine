/**
 * DISCLOSURE FENCE — no unauthenticated route may hand upstream error text to a caller.
 *
 * THE PATTERN THIS ENDS. Eight public routers had each grown their own
 *
 *     return res.status(500).json({ error: 'x_failed', detail: e?.message ?? String(e) });
 *
 * Proven reachable with nothing but a GET and an arbitrary string: /api/v1/repid/:id/history
 * passed an unresolvable slug to a `uuid` column, Postgres raised 22P02, and the route
 * replied to a stranger with
 *
 *     invalid input syntax for type uuid: "trinity-does-not-exist"
 *
 * — an internal column type plus their own probe, echoed back, on an endpoint with no auth
 * in front of it.
 *
 * WHY A SOURCE SCAN RATHER THAN PER-ROUTE TESTS. Earlier in this same effort, auditing call
 * sites by grepping for the shapes I could think of MISSED one, because its value sat in a
 * plain local. Per-route tests have the same weakness: they cover the routes someone
 * remembered to write a test for. This asserts the property across every public router file
 * at once, so a NEW router with the old habit fails on the day it is added rather than
 * whenever someone next audits by hand.
 *
 * THE RULE: in a public router, a `detail:` field may hold a STRING LITERAL we wrote (a
 * rate-limit message is our own copy, and useful). It may never hold anything derived from a
 * caught error. The real message belongs in the server log — see src/routes/public-error.ts.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROUTES = path.resolve(__dirname, '../src/routes');

/**
 * The public router set is DERIVED from src/index.ts, not listed here.
 *
 * The first version of this fence hard-coded eight filenames. Two public routers were
 * missing from it — hal-evaluate (mounted line 276) and vertical-leaderboard (line 432) —
 * and both were still leaking upstream error text while this test sat green. A
 * hand-maintained list of things to check is a list of the things someone remembered, which
 * is the same failure that let a copied resolver diverge and let a grep miss the anchor leg.
 *
 * So: parse the mount order. Everything mounted before `app.use(authMiddleware)` is
 * reachable with no credential and must obey the rule — including a router added tomorrow by
 * someone who never reads this file.
 */
function derivePublicRouters(): string[] {
  const index = readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8').split('\n');
  const authLine = index.findIndex((l) => /^app\.use\(authMiddleware\)/.test(l));
  if (authLine < 0) throw new Error('authMiddleware mount not found — the derivation is broken, not the routes');

  // varName -> './routes/foo'
  const importPath = new Map<string, string>();
  for (const l of index) {
    const m = l.match(/^import\s+(?:\{\s*[^}]*?\b(\w+)\b[^}]*\}|(\w+))\s+from\s+'(\.\/routes\/[^']+)'/);
    if (m) importPath.set(m[1] ?? m[2], m[3]);
    // `import { publicRouter as xRouter, statsRouter as yRouter } from './routes/z'`
    const multi = l.match(/^import\s+\{([^}]*)\}\s+from\s+'(\.\/routes\/[^']+)'/);
    if (multi) {
      for (const part of multi[1].split(',')) {
        const alias = part.includes(' as ') ? part.split(' as ')[1] : part;
        const name = alias.trim();
        if (name) importPath.set(name, multi[2]);
      }
    }
  }

  const files = new Set<string>();
  for (let i = 0; i < authLine; i++) {
    for (const m of index[i].matchAll(/app\.use\((?:'[^']*',\s*)?(\w+)\)/g)) {
      const p2 = importPath.get(m[1]);
      if (p2) files.add(`${p2.replace('./routes/', '')}.ts`);
    }
  }
  return [...files].sort();
}

const PUBLIC_ROUTERS = derivePublicRouters();

/** `detail:` whose value mentions an error binding rather than being a literal. */
const LEAKY_DETAIL = /detail:\s*(?![`'"])[^,}\n]*\b(e|err|error|upErr|ex)\b[^,}\n]*/g;

describe('public routers never serialise upstream error text', () => {
  test.each(PUBLIC_ROUTERS)('%s', (file) => {
    const p = path.join(ROUTES, file);
    if (!existsSync(p)) return; // renamed/removed is not a leak
    const src = readFileSync(p, 'utf8');
    const offenders: string[] = [];
    for (const line of src.split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue; // comments may describe the old pattern
      for (const m of line.match(LEAKY_DETAIL) ?? []) offenders.push(m.trim());
    }
    expect(`${file}: ${offenders.join(' | ') || 'clean'}`).toBe(`${file}: clean`);
  });

  test('a literal detail is still allowed — this bans leakage, not the field', () => {
    const src = readFileSync(path.join(ROUTES, 'leaderboard.ts'), 'utf8');
    // The rate-limit message is our own copy and genuinely helps a caller.
    expect(src).toMatch(/detail: 'too many rating\/vote writes/);
    expect((src.match(LEAKY_DETAIL) ?? []).length).toBe(0);
  });

  test('the fence can fail — a synthetic leak is detected', () => {
    const leaky = "    return res.status(500).json({ error: 'x_failed', detail: e?.message ?? String(e) });";
    expect((leaky.match(LEAKY_DETAIL) ?? []).length).toBeGreaterThan(0);
    const clean = "    return res.status(500).json({ error: 'x_failed' });";
    expect((clean.match(LEAKY_DETAIL) ?? []).length).toBe(0);
    const literal = "  message: { error: 'rate_limited', detail: 'too many writes' },";
    expect((literal.match(LEAKY_DETAIL) ?? []).length).toBe(0);
  });
});

describe('the error helper exists once and is imported, not copied', () => {
  // The bug that started this was a helper three routes had COPIED instead of imported: the
  // fix landed in the original and never reached the copies. Re-solving it by pasting an
  // error helper into eight files would reproduce that failure with a different function.
  test('exactly one definition of publicError in the tree', () => {
    const files = require('node:fs').readdirSync(ROUTES).filter((f: string) => f.endsWith('.ts'));
    let defs = 0;
    for (const f of files) {
      const src = readFileSync(path.join(ROUTES, f), 'utf8');
      defs += (src.match(/^export function publicError|^function publicError/gm) ?? []).length;
    }
    expect(`publicError definitions: ${defs}`).toBe('publicError definitions: 1');
  });
});

describe('log formatting is safe to ship to a log aggregator', () => {
  const { forLog } = require('../src/routes/public-error');

  test.each([
    ['a JWT', 'failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', /<jwt:redacted>/],
    ['an sk- key', 'bad key sk-abcdefghijklmnop', /<sk:redacted>/],
    ['a byok token', 'token hdg_byok_abcdefgh rejected', /<hdg:redacted>/],
    ['a bearer header', 'Authorization: Bearer abcdefghijklmnop', /Bearer <redacted>/],
  ])('redacts %s', (_n, input, expected) => {
    expect(forLog(input)).toMatch(expected);
    expect(forLog(input)).not.toMatch(/eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0|sk-abcdefghijklmnop|hdg_byok_abcdefgh/);
  });

  test('collapses newlines so one error cannot forge extra log lines', () => {
    expect(forLog('line one\nFAKE LOG LINE\r\nanother')).not.toMatch(/[\r\n]/);
  });

  test('bounds length', () => {
    const out = forLog('x'.repeat(5000));
    expect(out.length).toBeLessThan(600);
    expect(out).toMatch(/\+\d+/);
  });
});
