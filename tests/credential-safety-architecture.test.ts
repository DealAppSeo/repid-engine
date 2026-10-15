/**
 * D-108 / CLAUDE_RULES r32, enforcement layer 2: ONE verifier.
 *
 * src/auth/api-keys.ts is the only file that may read an agent credential field or compare a secret;
 * everything else calls it. This is a plain grep over runtime code under src/ (tests excluded), with an
 * explicit allowlist below. Comment lines are skipped: docs may name a field, code may not read it.
 *
 * The retired legacy token (`legacyTokenMatches`, `api_key_sha256`) is banned EVERYWHERE, the verifier
 * included: it authorizes nothing now, so any code touching it is the old path coming back.
 *
 * If this fails on your change: route the check through src/auth/api-keys.ts (constant-time compare
 * there), or, if the hit is not a credential, add an allowlist entry with the exact snippet and why.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..');
const VERIFIER = 'src/auth/api-keys.ts';

const SECRET_NAME = /(^|[a-z0-9_])(token|key|secret|password|passphrase|mnemonic)$/i;
const OPERAND = String.raw`(?:process\.env\.)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*`;
const EQUALITY = new RegExp(`(${OPERAND})\\s*[!=]==?\\s*(${OPERAND})`, 'g');
const NOT_A_VALUE = /^(null|undefined|true|false|NaN|typeof)$/;

type Rule = { everywhere?: boolean; find: (line: string) => string[] };
const RULES: Record<string, Rule> = {
  'constitution.api_key': {
    find: (l) => l.match(/constitution\s*(?:\?\.|\.)\s*api_key\w*|constitution\s*(?:\?\.)?\[\s*['"`]api_key\w*/g) ?? [],
  },
  "->>'api_key'": { find: (l) => l.match(/->>\s*'api_key\w*'/g) ?? [] },
  privateId: { find: (l) => l.match(/\bprivateId\w*/g) ?? [] },
  'secret-equality': {
    find: (l) =>
      [...l.matchAll(EQUALITY)]
        .filter(([, a, b]) => !NOT_A_VALUE.test(a) && !NOT_A_VALUE.test(b))
        .filter(([, a, b]) => SECRET_NAME.test(a.split('.').pop()!) || SECRET_NAME.test(b.split('.').pop()!))
        .map((m) => m[0]),
  },
  'retired-legacy-token': { everywhere: true, find: (l) => l.match(/\blegacyTokenMatches\b|\bapi_key_sha256\b/g) ?? [] },
};

/** `snippet` omitted = the whole rule is allowed in that file. Keep entries exact; debt is paid by deleting them. */
const ALLOW: Array<{ file: string; rule: string; snippet?: string; why: string }> = [
  { file: 'src/routes/agents.ts', rule: 'privateId', why: 'POST /agents/human generates it, stores only privateId_sha256, returns it once' },
  // Not credentials: the names only look like it.
  { file: 'src/routes/belts.ts', rule: 'secret-equality', snippet: 'row.name === key', why: 'a belt row name' },
  { file: 'src/services/peer-verify-consensus.ts', rule: 'secret-equality', snippet: 'now.closure_reason === token', why: 'a closure-reason marker' },
  { file: 'src/zkrepid/disclosure.ts', rule: 'secret-equality', snippet: 'value === scoreToken', why: 'the score rendered as a string' },
];

type Hit = { file: string; line: number; rule: string; snippet: string };

function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [rule, r] of Object.entries(RULES)) {
      if (file === VERIFIER && !r.everywhere) continue;
      for (const snippet of r.find(line)) hits.push({ file, line: i + 1, rule, snippet });
    }
  });
  return hits;
}

const allowedBy = (h: Hit) => ALLOW.find((a) => a.file === h.file && a.rule === h.rule && (a.snippet === undefined || a.snippet === h.snippet));

function runtimeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') runtimeFiles(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const allHits = runtimeFiles(join(ROOT, 'src')).flatMap((f) => scan(relative(ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')));

describe('credential safety: one verifier (D-108, r32)', () => {
  it('no runtime file under src/ reads a credential field or compares a secret outside the verifier', () => {
    expect(allHits.filter((h) => !allowedBy(h))).toEqual([]);
  });

  it('every allowlist entry still matches something (paid debt leaves the list)', () => {
    expect(ALLOW.filter((a) => !allHits.some((h) => allowedBy(h) === a))).toEqual([]);
  });

  it.each([
    ['constitution.api_key', 'const t = agent.constitution.api_key;'],
    ['constitution.api_key', 'if (row.constitution?.api_key) ok();'],
    ['constitution.api_key', "const t = constitution['api_key'];"],
    ["->>'api_key'", "const q = `select constitution->>'api_key' from repid_agents`;"],
    ['privateId', 'const id = req.body.privateId;'],
    ['secret-equality', 'if (provided === process.env.CONTROLLER_MASTER_KEY) next();'],
    ['secret-equality', 'if (presentedToken !== storedSecret) return deny();'],
    ['retired-legacy-token', 'return legacyTokenMatches(c, token);'],
  ])('catches a planted %s violation', (rule, planted) => {
    const hits = scan('src/routes/planted.ts', planted);
    expect(hits.map((h) => h.rule)).toContain(rule);
    expect(hits.filter((h) => !allowedBy(h))).not.toHaveLength(0);
  });

  it('the allowlist is per snippet: a NEW secret compare in an allowlisted file is still caught', () => {
    expect(scan('src/routes/belts.ts', 'if (header === secret) next();').filter((h) => !allowedBy(h))).toHaveLength(1);
  });

  // The r32 debt #1408 allowlisted is paid: these four compares now go through secretEquals in the
  // verifier. Re-adding any one of them, verbatim, in its old file fails the build.
  it.each([
    ['src/middleware/auth.ts', '    if (key === apiKey) {'],
    ['src/routes/route.ts', '        if (key === token) {'],
    ['src/routes/admin-caps.ts', '  if (reqKey !== adminKey) {'],
    ['src/routes/admin-flags.ts', '  if (reqKey !== adminKey) {'],
  ])('paid debt stays paid: a direct compare re-added in %s is caught', (file, planted) => {
    expect(scan(file, planted).filter((h) => !allowedBy(h)).map((h) => h.rule)).toEqual(['secret-equality']);
  });

  it('the retired legacy token is banned in the verifier too', () => {
    expect(scan(VERIFIER, "if (typeof c.api_key_sha256 === 'string') return true;").map((h) => h.rule)).toEqual(['retired-legacy-token']);
  });

  it('does not flag comments, typeof checks or null checks', () => {
    for (const ok of ['// constitution.api_key is retired', ' * privateId was stored here', "if (typeof key === 'string') x();", 'if (token === null) x();']) {
      expect(scan('src/routes/planted.ts', ok)).toEqual([]);
    }
  });
});
