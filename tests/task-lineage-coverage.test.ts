/**
 * L2 breaker 2.2 — INSERT-SITE COVERAGE PIN.
 *
 * WHY THIS EXISTS. Breaker 2.2 shipped with its enqueue chokepoints enumerated
 * by a one-time `grep`, and the PR said "all six". An independent verifier then
 * found a SEVENTH — `POST /directives`, operator task injection — with no
 * lineage tagging at all. The defect was not the missing line; it was that the
 * enumeration lived in prose and could not be re-run. This is the same shape as
 * the emergency-halt coverage hole (a "global" switch that reached 3 of 14 tick
 * loops), and it is fixed the same way: the enumeration walks the filesystem in
 * CI, so a new `trinity_tasks` insert added next month fails here until someone
 * classifies it on purpose.
 *
 * COUNTED PER INSERT SITE, NOT PER FILE — this is the whole lesson. The halt
 * pin originally counted per FILE and six loops hid behind one justification.
 * Here `controller.ts` holds THREE inserts and `peer-verification-reader.ts`
 * holds TWO: a file-granular check would have reported both as covered while
 * `/directives` sat untagged, which is exactly what happened.
 *
 * WHAT COUNTS AS COVERED: the insert's own argument block spreads a lineage
 * decision (`...rootLineage()`, `...lineage`, `...guarded.fields`) or names the
 * columns outright (`parent_task_id:` / `generation:`). Comments are stripped
 * before matching — a tag mentioned in prose above an untagged insert is
 * precisely the false pass this file has to refuse.
 *
 * BUILT SO IT CANNOT PASS VACUOUSLY. Every assertion below has been run against
 * the absence of the property it asserts (see the mutation set in the beat
 * report); a pin that has never failed proves nothing.
 */

describe('L2 breaker 2.2 — trinity_tasks insert-site coverage (filesystem-pinned)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const SRC = path.join(__dirname, '..', 'src');
  const NEWLINE = String.fromCharCode(10);

  /**
   * Sites that deliberately carry NO lineage. Empty today, and the rule that
   * keeps it honest is below: one entry may cover AT MOST ONE site. A file-wide
   * exemption is what let six tick loops hide behind a single line.
   * Key format: `<rel path>#<0-based index of the insert within that file>`.
   */
  const EXEMPT = new Set<string>([]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  /**
   * Strip `//` and block comments. Deliberately conservative: it does not try to
   * parse strings, so a `//` inside a string literal would over-strip. That is
   * the safe direction here — over-stripping can only ever REMOVE a tag and
   * fail the pin, never invent one.
   */
  function stripComments(body: string): string {
    return body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(NEWLINE)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join(NEWLINE);
  }

  /** Text between the parens of `.insert(` starting at `open`, by bracket depth. */
  function argumentBlock(body: string, open: number): string {
    let depth = 0;
    for (let i = open; i < body.length; i++) {
      const c = body[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        depth--;
        if (depth === 0) return body.slice(open, i + 1);
      }
    }
    return body.slice(open); // unbalanced — hand back the rest and let the tag check decide
  }

  const TAGS = ['...rootLineage(', '...lineage', '...guarded.fields', 'parent_task_id:', 'generation:'];
  const isTagged = (block: string) => TAGS.some((t) => block.includes(t));

  /**
   * Every `.insert(` whose statement targets `trinity_tasks`. Anchored on the
   * table name, then walked forward to the first `.insert(` with no `;` in
   * between, so a nearby insert into a DIFFERENT table cannot be miscounted as
   * covered. Deduped by the offset of the `.insert(` token, because the table
   * name often appears more than once in one statement's neighbourhood.
   */
  function insertSites(rel: string, raw: string) {
    const body = stripComments(raw);
    const sites: { key: string; rel: string; block: string; offset: number }[] = [];
    const seen = new Set<number>();
    const table = /trinity_tasks/g;
    let m: RegExpExecArray | null;
    while ((m = table.exec(body))) {
      const rest = body.slice(m.index, m.index + 400);
      const hit = /^[^;]{0,200}?\.insert\(/s.exec(rest);
      if (!hit) continue;
      const open = m.index + hit[0].length - 1; // index of the '('
      if (seen.has(open)) continue;
      seen.add(open);
      sites.push({ key: '', rel, block: argumentBlock(body, open), offset: open });
    }
    sites.sort((a, b) => a.offset - b.offset);
    return sites.map((s, i) => ({ ...s, key: `${rel}#${i}` }));
  }

  const SITES = walk(SRC).flatMap((f) =>
    insertSites(path.relative(SRC, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')),
  );

  it('ANTI-VACUITY: the scan actually finds the insert sites, in the files it should', () => {
    expect(SITES.length).toBeGreaterThanOrEqual(6);
    const rels = SITES.map((s) => s.rel);
    expect(rels).toContain('routes/v1/controller.ts');
    expect(rels).toContain('services/peer-verification-reader.ts');
    expect(rels).toContain('services/receipt-indexer.ts');
    // per-SITE, not per-file: the two multi-insert files are the reason this pin exists
    expect(rels.filter((r) => r === 'routes/v1/controller.ts').length).toBeGreaterThanOrEqual(3);
    expect(rels.filter((r) => r === 'services/peer-verification-reader.ts').length).toBeGreaterThanOrEqual(2);
  });

  it('ANTI-VACUITY: a tag in a COMMENT does not count as coverage', () => {
    const commented = [
      "await db.from('trinity_tasks').insert({",
      '  title: 1,',
      '  // ...rootLineage(),',
      '});',
    ].join(NEWLINE);
    const sites = insertSites('fake.ts', commented);
    expect(sites).toHaveLength(1);
    expect(isTagged(sites[0]!.block)).toBe(false);
  });

  it('ANTI-VACUITY: the site walker finds a real tag, and does not leak past the insert', () => {
    const tagged = [
      "await db.from('trinity_tasks').insert({ title: 1, ...rootLineage() });",
      "await db.from('other_table').insert({ nothing: true });",
    ].join(NEWLINE);
    const sites = insertSites('fake.ts', tagged);
    expect(sites).toHaveLength(1);
    expect(isTagged(sites[0]!.block)).toBe(true);
    expect(sites[0]!.block).not.toContain('other_table');
  });

  it('ANTI-VACUITY: an insert into a different table is not counted', () => {
    const other = "await db.from('trinity_leads').insert({ email: 'a@b.c' });";
    expect(insertSites('fake.ts', other)).toHaveLength(0);
  });

  it('EVERY trinity_tasks insert site carries lineage or is explicitly exempt', () => {
    const untagged = SITES.filter((s) => !EXEMPT.has(s.key)).filter((s) => !isTagged(s.block)).map((s) => s.key);
    expect(untagged).toEqual([]);
  });

  it('no exemption covers more than one site, and every entry is real', () => {
    for (const key of EXEMPT) {
      expect(SITES.map((s) => s.key)).toContain(key);
      expect(key).toMatch(/#\d+$/); // a bare file path would be a blanket exemption
    }
  });

  it('REGRESSION: POST /directives is tagged (the site the original grep missed)', () => {
    const directives = SITES.filter((s) => s.rel === 'routes/v1/controller.ts').find((s) =>
      s.block.includes('success_criteria'),
    );
    expect(directives).toBeDefined();
    expect(directives!.block).toContain('...rootLineage()');
  });

  it('REGRESSION: /wake, /sprint and both peer-verify dispatches stay tagged', () => {
    const byMarker = (rel: string, marker: string) =>
      SITES.filter((s) => s.rel === rel).find((s) => s.block.includes(marker));
    expect(byMarker('routes/v1/controller.ts', 'CONTROLLER_WAKE')!.block).toContain('...rootLineage()');
    expect(isTagged(byMarker('routes/v1/controller.ts', "task_type: 'system'")!.block)).toBe(true);
    expect(byMarker('services/peer-verification-reader.ts', 'PEER_VERIFY_PANEL')!.block).toContain('...rootLineage()');
    expect(byMarker('services/receipt-indexer.ts', 'receipt_validation')!.block).toContain('...rootLineage()');
  });
});
