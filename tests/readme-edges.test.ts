/**
 * README EDGES, PINNED (Sean, 2026-10-07): "Each README names only what it calls and what calls it,
 * and links to the map. A pin test on those edges, not on a picture."
 *
 * The README's "Where this sits" section and its request-pipeline text are claims about this repo's
 * code. A README is read as true long after the code under it moves, so each claim that CAN be
 * checked from this repo is checked here, by reading the source as text:
 *
 *   - the prover URL the README names    == PINNED_PROVER_URL in src/config/prover.ts
 *   - the verifier dependency it names   is in package.json, installed from the repo it names
 *   - the registry addresses it names    == the Base Sepolia literals in src/config/network.ts
 *   - the controller address it names    == the default in both escalation call sites
 *   - package.json "license"             == what LICENSE's first lines say
 *   - the map link                       is present
 *   - the request pipeline order         == the order of app.use(...) calls in src/index.ts, and
 *                                           every global middleware in src/index.ts is listed
 *
 * NOT CHECKED HERE: the "Called by" edges. They live in other repositories' code, which this repo
 * cannot read in CI. A green run says nothing about them.
 *
 * Every parse below asserts it found something before comparing, so an empty parse fails instead of
 * passing (LESSONS rule 5: an instrument that cannot return the other answer has measured nothing).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const README = read('README.md');
const MAP_LINK = 'https://github.com/DealAppSeo/hyperdag-protocol/blob/main/BUILDERS.md#how-the-pieces-fit';

/** Body of a markdown section, from its heading line to the next heading of the same or higher level. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) throw new Error(`README has no "${heading}" heading`);
  const level = heading.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** The top-level bullet (with its indented continuation lines) whose first line matches `label`. */
function bullet(md: string, label: RegExp): string {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => label.test(l));
  if (start < 0) throw new Error(`no bullet matching ${label}`);
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^- /.test(l) || /^\*\*/.test(l) || /^#/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

/** https URLs in a text, with trailing sentence punctuation removed. */
function urls(text: string): string[] {
  return (text.match(/https:\/\/[^\s)`>\]"']+/g) ?? []).map((u) => u.replace(/[.,;:]+$/, ''));
}

const WHERE = section(README, '## Where this sits');

describe('README "Where this sits" — edges that live in this repo', () => {
  it('links to the whole map in BUILDERS.md', () => {
    expect(WHERE).toContain(MAP_LINK);
  });

  it('names the prover URL that src/config/prover.ts pins, and ZKP_SERVICE_URL as the override', () => {
    const src = read('src/config/prover.ts');
    const pinned = src.match(/export const PINNED_PROVER_URL\s*=\s*['"]([^'"]+)['"]/)?.[1];
    expect(pinned).toMatch(/^https:\/\//);
    expect(src).toMatch(/env\.ZKP_SERVICE_URL\s*\|\|\s*PINNED_PROVER_URL/);

    const proverBullet = bullet(WHERE, /^- \*\*The prover\*\*/);
    const named = urls(proverBullet).filter((u) => !/^https:\/\/github\.com\//.test(u));
    expect(named).toEqual([pinned]);
    expect(proverBullet).toContain('ZKP_SERVICE_URL');

    // No second prover host anywhere else in the README either.
    const proverLike = /^https:\/\/[a-z0-9.-]*(?:zkp|prover|plonky|postcard)[a-z0-9.-]*/i;
    const elsewhere = urls(README).filter((u) => proverLike.test(u) && u !== pinned);
    expect(elsewhere).toEqual([]);
  });

  it('names @hyperdag/proof-verifier, which package.json depends on, from the repo the README names', () => {
    const pkg = JSON.parse(read('package.json'));
    const spec: unknown = pkg.dependencies?.['@hyperdag/proof-verifier'];
    expect(typeof spec).toBe('string');

    const verifierBullet = bullet(WHERE, /^- \*\*`@hyperdag\/proof-verifier`\*\*/);
    const repos = urls(verifierBullet)
      .map((u) => u.match(/^https:\/\/github\.com\/([^/]+\/[^/#?]+)/)?.[1])
      .filter((r): r is string => !!r);
    expect(repos.length).toBeGreaterThan(0);
    for (const r of repos) expect((spec as string).toLowerCase()).toContain(r.toLowerCase());
  });

  it('names the Base Sepolia registry addresses that src/config/network.ts uses, and no others', () => {
    const net = read('src/config/network.ts');
    const reputation = net.match(/reputationRegistry:\s*['"](0x[0-9a-fA-F]{40})['"]/)?.[1];
    const identity = net.match(/identityRegistry:\s*['"](0x[0-9a-fA-F]{40})['"]/)?.[1];
    expect(reputation).toBeDefined();
    expect(identity).toBeDefined();

    expect(WHERE).toContain(reputation!);
    expect(WHERE).toContain(identity!);

    const named = new Set((README.match(/0x8004[0-9a-fA-F]{36}\b/g) ?? []).map((a) => a.toLowerCase()));
    expect(named.size).toBeGreaterThan(0);
    expect([...named].sort()).toEqual([identity!, reputation!].map((a) => a.toLowerCase()).sort());
  });

  it('names the controller address both escalation call sites default to', () => {
    const defaults = ['src/services/escalation-router.ts', 'src/services/hitl-notification-dispatcher.ts'].map(
      (f) => read(f).match(/CONTROLLER_APP_URL\s*\|\|\s*['"]([^'"]+)['"]/)?.[1],
    );
    expect(defaults[0]).toMatch(/^https:\/\//);
    expect(defaults[1]).toBe(defaults[0]);

    const controllerBullet = bullet(WHERE, /^- \*\*The controller\*\*/);
    expect(urls(controllerBullet)).toEqual([defaults[0]]);
    expect(controllerBullet).toContain('CONTROLLER_APP_URL');
  });
});

describe('package.json "license" agrees with LICENSE', () => {
  it('maps the first lines of LICENSE to the SPDX id package.json declares', () => {
    const head = read('LICENSE').split('\n').slice(0, 6).join('\n');
    const KNOWN: Array<[RegExp, string]> = [
      [/Apache License[\s\S]*Version 2\.0/, 'Apache-2.0'],
      [/^\s*MIT License/m, 'MIT'],
      [/^\s*ISC License/m, 'ISC'],
    ];
    const spdx = KNOWN.find(([re]) => re.test(head))?.[1];
    // An unrecognised LICENSE header is NOT CHECKED, never a pass: fail and make someone add it.
    expect(spdx).toBeDefined();
    expect(JSON.parse(read('package.json')).license).toBe(spdx);
  });
});

describe('README request pipeline matches the app.use(...) order in src/index.ts', () => {
  /** Prose names in the README that stand for an inline function, located by a string inside it. */
  const ALIASES: Record<string, string> = {
    'JSON parse-error handler': 'entity.parse.failed',
    'SQL-keyword sanitizer': 'Forbidden SQL keywords detected',
  };
  /** Prose names that stand for a group of routers, deliberately not pinned to one call. */
  const GROUPS = new Set(['public routers', 'authed routers']);

  const index = read('src/index.ts');

  /** One segment per app.use call: from its `app.use(` to the next one. Line 1 is the call head. */
  const segments: Array<{ line: number; head: string; body: string }> = [];
  {
    const starts: number[] = [];
    const re = /^[ \t]*app\.use\(/gm;
    for (let m = re.exec(index); m; m = re.exec(index)) starts.push(m.index);
    starts.forEach((s, i) => {
      const body = index.slice(s, starts[i + 1] ?? index.length);
      segments.push({
        line: index.slice(0, s).split('\n').length,
        head: body.split('\n')[0]!.trim(),
        body,
      });
    });
  }

  /** README pipeline names, in order, from the first ```text block under "### Request pipeline". */
  const names: string[] = (() => {
    const sec = section(README, '### Request pipeline (`src/index.ts`)');
    const block = sec.match(/```text\n([\s\S]*?)```/)?.[1];
    if (!block) throw new Error('README request pipeline has no ```text block');
    return block
      .split('\n')
      .map((l) => l.replace(/^\s*→\s*/, '').trim())
      .filter(Boolean)
      .map((l) => l.split(/\s{2,}/)[0]!.trim())
      .flatMap((col) => col.split(/,\s*/))
      .map((n) => n.trim())
      .filter(Boolean);
  })();

  function locate(name: string): number {
    if (ALIASES[name]) {
      return segments.findIndex((s) => /^app\.use\(\s*\(/.test(s.head) && s.body.includes(ALIASES[name]!));
    }
    const id = name.replace(/\(.*\)$/, '');
    if (!/^[A-Za-z_$][\w$.]*$/.test(id)) {
      throw new Error(
        `README pipeline names "${name}", which this test cannot locate. Use the code identifier, ` +
          `or add it to ALIASES (with a string from inside it) or GROUPS in tests/readme-edges.test.ts.`,
      );
    }
    const word = new RegExp(`(^|[^\\w$.])${id.replace(/[.$]/g, '\\$&')}(?![\\w$])`);
    return segments.findIndex((s) => word.test(s.head.replace(/^app\.use\(/, '')));
  }

  it('parses something on both sides (an empty parse must not pass)', () => {
    expect(segments.length).toBeGreaterThan(10);
    expect(names.length).toBeGreaterThan(10);
  });

  it('every middleware the README names is mounted, in the README order', () => {
    const pinned = names.filter((n) => !GROUPS.has(n));
    const located = pinned.map((n) => ({ name: n, at: locate(n) }));

    const missing = located.filter((x) => x.at < 0).map((x) => x.name);
    expect(missing).toEqual([]);

    const outOfOrder: string[] = [];
    for (let i = 1; i < located.length; i++) {
      const prev = located[i - 1]!;
      const cur = located[i]!;
      if (cur.at <= prev.at) {
        outOfOrder.push(
          `README puts "${cur.name}" (src/index.ts:${segments[cur.at]!.line}) after ` +
            `"${prev.name}" (src/index.ts:${segments[prev.at]!.line})`,
        );
      }
    }
    expect(outOfOrder).toEqual([]);
  });

  it('every global middleware in src/index.ts is listed in the README pipeline', () => {
    // Global = mounted with no path. A bare `xyzRouter` is a router, not middleware, and is covered
    // by "public routers" / "authed routers"; everything else mounted globally must be named.
    const global = segments
      .map((s, i) => ({ ...s, i }))
      .filter((s) => !/^app\.use\(\s*['"`]/.test(s.head))
      .filter((s) => !/^app\.use\(\s*[A-Za-z_$][\w$]*Router\s*\)/.test(s.head));
    expect(global.length).toBeGreaterThan(0);

    const claimed = new Set(names.filter((n) => !GROUPS.has(n)).map(locate));
    const unlisted = global.filter((s) => !claimed.has(s.i)).map((s) => `src/index.ts:${s.line}: ${s.head}`);
    expect(unlisted).toEqual([]);
  });
});
