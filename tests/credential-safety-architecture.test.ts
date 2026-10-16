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
 * An operand is a name, a member chain, a call or an index: `req.header('X-Cron-Token') !== token` and
 * `x !== webhookSecret(token)` are compares too, named by the callee or the header they read.
 *
 * `.includes(` / `.indexOf(` on a key or token array is also banned: it is a `===` per element.
 * Use `keys.some((k) => secretEquals(k, presented))`.
 *
 * If this fails on your change: route the check through src/auth/api-keys.ts (constant-time compare
 * there), or, if the hit is not a credential, add an allowlist entry with the exact snippet and why.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..');
const VERIFIER = 'src/auth/api-keys.ts';

const SECRET_NAME = /(token|key|secret|password|passphrase|mnemonic|signature|hmac)$/i;
// Call args (one nesting level) and an index: `req.header('X-Cron-Token')`, `webhookSecret(token)`, `h['x-api-key']`.
const CALL_OR_INDEX = String.raw`(?:\?\.)?(?:\((?:[^()]|\([^()]*\))*\)|\[[^\[\]]*\])`;
// A name, then any chain of `.member`, `?.member`, calls and indexes. `process.env.X` is a member chain.
const OPERAND = String.raw`[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|${CALL_OR_INDEX})*`;
const EQUALITY = new RegExp(`(${OPERAND})\\s*[!=]==?\\s*(${OPERAND})`, 'g');
const NOT_A_VALUE = /^(null|undefined|true|false|NaN|typeof)$/;
// `.trim()` / `.toLowerCase()` do not rename a value: `presented.trim() === secret.trim()` compares the secret.
const SAME_VALUE = /(?:\??\.(?:trim|toLowerCase|toUpperCase|toString|normalize)\(\))+$/;
const TRAILING_CALLS = new RegExp(`(?:${CALL_OR_INDEX})+$`);
/** What an operand is called: its last member or callee, and every string key it reads ('X-Cron-Token'). */
function namesOf(operand: string): string[] {
  const core = operand.replace(SAME_VALUE, '');
  const keys = [...core.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return [core.replace(TRAILING_CALLS, '').split('.').pop()!, ...keys];
}
const namedSecret = (operand: string) => namesOf(operand).some((n) => SECRET_NAME.test(n));
// A COLLECTION of secrets (`keys`, `apiTokens`, `adminKeyList`); a singular `key.includes(':')` is a string op.
const SECRET_LIST = /(keys|tokens|secrets|passwords|passphrases|(key|token|secret|password)(list|set|array))$/i;
const MEMBERSHIP = new RegExp(`(${OPERAND})\\s*\\??\\.\\s*(?:includes|indexOf)\\s*\\(`, 'g');

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
        .filter(([, a, b]) => namedSecret(a) || namedSecret(b))
        .map((m) => m[0]),
  },
  // `keys.includes(presented)` is a `===` per element: not constant-time.
  'secret-membership': {
    find: (l) => [...l.matchAll(MEMBERSHIP)].filter(([, recv]) => SECRET_LIST.test(namesOf(recv)[0])).map((m) => m[0]),
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
  // Found when operands widened to calls, indexes and `.toLowerCase()` (r32 follow-up). Public values.
  { file: 'src/classify/free-votes.ts', rule: 'secret-equality', snippet: 'hostKey(o) === hostKey(v)', why: '`provider:model` dedupe key' },
  { file: 'src/classify/free-votes.ts', rule: 'secret-equality', snippet: 'hostKey(p) === hostKey(v)', why: '`provider:model` dedupe key' },
  { file: 'src/classify/free-votes.ts', rule: 'secret-equality', snippet: 'hostKey(a) === hostKey(b)', why: '`provider:model` dedupe key' },
  { file: 'src/repid/repid-attestation.ts', rule: 'secret-equality', snippet: 'signing_pubkey.trim() !== km.publicKeyB64', why: 'a PUBLIC key, published on every attestation' },
  { file: 'src/scoring/confirmed-outcome.ts', rule: 'secret-equality', snippet: 'actorOwner.ownerKey.toLowerCase() === cpOwner.ownerKey.toLowerCase()', why: 'an owner id (builder id / wallet / SBT token id)' },
  { file: 'src/services/agent-owner-resolver.ts', rule: 'secret-equality', snippet: 'a.ownerKey.toLowerCase() === b.ownerKey.toLowerCase()', why: 'an owner id (builder id / wallet / SBT token id)' },
  { file: 'src/scoring/grounding.ts', rule: 'secret-equality', snippet: 'log.address.toLowerCase() !== token', why: 'an ERC-20 token contract address' },
  { file: 'src/routes/cache-stats.ts', rule: 'secret-membership', snippet: 'keys.includes(', why: 'Redis INFO field names' },
  { file: 'src/zkrepid/disclosure.ts', rule: 'secret-membership', snippet: 'expectedKeys.includes(', why: 'object field names of the pinned public surface' },
  { file: 'src/zkrepid/disclosure.ts', rule: 'secret-membership', snippet: 'actualKeys.includes(', why: 'object field names of the pinned public surface' },
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
    // Call and index operands (Grok's #1409 review): the secret is named by the callee or the header.
    ['secret-equality', "if (!token || req.header('X-Cron-Token') !== token) {"],
    ['secret-equality', "if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret(token)) {"],
    ['secret-equality', "if (req.headers['x-api-key'] === expected) next();"],
    ['secret-equality', 'if (getAdminKey() === provided) next();'],
    ['secret-equality', "if (cfg['adminKey'] === provided) next();"],
    ['secret-equality', 'if (presented.trim() === secret.trim()) ok();'],
    ['secret-equality', 'if (given != hmac) deny();'],
    ['secret-equality', 'if (header === signature) ok();'],
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
    // The compares the identifier-only scan could not see (Grok's #1409 review).
    ['src/routes/v1/internal-cron.ts', "    if (!token || req.header('X-Cron-Token') !== token) {"],
    ['src/routes/telegram-public.ts', "    if (req.get('x-telegram-bot-api-secret-token') !== webhookSecret(token)) {"],
  ])('paid debt stays paid: a direct compare re-added in %s is caught', (file, planted) => {
    expect(scan(file, planted).filter((h) => !allowedBy(h)).map((h) => h.rule)).toEqual(['secret-equality']);
  });

  it('paid debt stays paid: the REPID_API_KEYS membership check re-added in src/routes/marketplace.ts is caught', () => {
    expect(scan('src/routes/marketplace.ts', '  if (envKeys.includes(candidateKey)) {').filter((h) => !allowedBy(h)).map((h) => h.rule)).toEqual(['secret-membership']);
  });

  it.each([
    ['src/middleware/env-api-key.ts', '  return keys.includes(presented);'],
    ['src/middleware/planted.ts', 'if (apiKeys.indexOf(token) >= 0) next();'],
    ['src/middleware/planted.ts', 'const ok = cfg.allowedTokens?.includes(t);'],
    ['src/auth/planted.ts', 'if (adminKeyList.includes(k)) ok();'],
    ['src/services/planted.ts', 'if (loadKeys().includes(k)) ok();'],
  ])('catches .includes/.indexOf membership on a key or token array in %s: %s', (file, planted) => {
    expect(scan(file, planted).filter((h) => !allowedBy(h)).map((h) => h.rule)).toEqual(['secret-membership']);
  });

  it('membership covers all of src/, and a non-secret list or a string op on one key is not membership', () => {
    expect(scan('src/routes/planted.ts', 'return keys.includes(presented);').map((h) => h.rule)).toEqual(['secret-membership']);
    expect(scan('src/middleware/planted.ts', 'if (scopes.includes(s)) x();')).toEqual([]);
    expect(scan('src/middleware/planted.ts', "if (key.includes(':')) x();")).toEqual([]);
  });

  it('the retired legacy token is banned in the verifier too', () => {
    expect(scan(VERIFIER, "if (typeof c.api_key_sha256 === 'string') return true;").map((h) => h.rule)).toEqual(['retired-legacy-token']);
  });

  it('does not flag comments, typeof checks, null checks, or a public value read from a call', () => {
    for (const ok of [
      '// constitution.api_key is retired',
      ' * privateId was stored here',
      "if (typeof key === 'string') x();",
      'if (token === null) x();',
      "if (typeof req.headers['x-api-key'] === 'string') x();",
      "if (req.header('content-type') === mime) x();",
      'return verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase();',
      'if (generaliseServiceType(key) === family) x();',
    ]) {
      expect(scan('src/routes/planted.ts', ok)).toEqual([]);
    }
  });
});
