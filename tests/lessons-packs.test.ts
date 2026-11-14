/**
 * lessons-packs.test.ts — proves the domain-pack second tier actually fires.
 *
 * Without this, keyword matching FAILS OPEN (LESSONS §5): a brief says "proof system",
 * the trigger says "plonky3", the pack silently does not load, and you have a rule that
 * exists and did not apply. So: every pack must declare >=1 trigger, and every pack must
 * fire against a representative brief written in natural language (not the trigger line
 * copied back). require() the CommonJS matcher so this runs on Windows too — importing
 * the ESM run-agent.mjs by absolute path throws ERR_UNSUPPORTED_ESM_URL_SCHEME there.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { loadPacks, matchPacks, parseTriggers, renderPacks, selectPacks, splitSections, packIndex, PACKS_MAX } = require('../scripts/dispatch/lessons-lib');

const LESSONS_DIR = path.join(__dirname, '..', 'lessons');

// Natural-language briefs that a real dispatch might carry — deliberately NOT the
// trigger list. If a new pack ships without a fixture here, the loop below fails.
const REPRESENTATIVE: Record<string, string> = {
  dispatch: 'Coordinator: fix the sprint-daemon self-chain deadlock and validate two consecutive dispatches in one worktree.',
  'hal-eval': 'Measure HAL F1 on the rigorous corpus across all providers and report the quorum and any provider failures.',
  schema: 'Land a migration adding sufficient-statistic columns to the score-event table; read the CHECK constraint before writing SQL.',
  zkp: 'Wire the plonky3 aggregation over the poseidon2 leaf and keep the A1 statement arity fixed.',
};

describe('LESSONS domain packs', () => {
  const packs = loadPacks(LESSONS_DIR);

  it('loads at least the four shipped packs (guards against an empty/false-green scan)', () => {
    expect(packs.length).toBeGreaterThanOrEqual(4);
    expect(packs.map((p: any) => p.name).sort()).toEqual(
      expect.arrayContaining(['dispatch', 'hal-eval', 'schema', 'zkp']),
    );
  });

  it('every pack declares >=1 trigger — a pack with none can never fire', () => {
    const noTrigger = packs.filter((p: any) => p.triggers.length === 0).map((p: any) => p.name);
    expect(noTrigger).toEqual([]);
  });

  it('every pack has a fixture brief in this test (so new packs cannot ship untested)', () => {
    const missing = packs.map((p: any) => p.name).filter((n: string) => !(n in REPRESENTATIVE));
    expect(missing).toEqual([]);
  });

  for (const p of packs) {
    it(`pack "${p.name}" fires on a natural-language brief`, () => {
      const brief = REPRESENTATIVE[p.name];
      const matched = matchPacks(brief, packs).map((m: any) => m.name);
      expect(matched).toContain(p.name);
    });
  }

  it('matches by substring, not exact token (the whole point)', () => {
    // "proofs" contains "proof"; a real brief rarely uses the exact trigger word.
    expect(matchPacks('working on zero-knowledge proofs', packs).map((m: any) => m.name)).toContain('zkp');
  });

  it('loads nothing for text that contains no trigger', () => {
    const matched = matchPacks('write landing page hero copy and a launch announcement', packs);
    expect(matched.map((m: any) => m.name)).not.toContain('zkp');
    expect(matched.map((m: any) => m.name)).not.toContain('hal-eval');
  });

  it('parseTriggers lowercases and splits on commas and whitespace', () => {
    expect(parseTriggers('<!-- triggers: Foo, BAR baz -->')).toEqual(['foo', 'bar', 'baz']);
    expect(parseTriggers('no header here')).toEqual([]);
  });

  // REPLACED 2026-11-14: "renderPacks with the real pack set stays under its own cap"
  // could never go red, because renderPacks already cut its output to the cap by dropping
  // packs. These can: a real pack that outgrows the budget alone, or a matched pack that
  // reaches the agent with nothing, fails here.
  describe('real packs', () => {
    for (const p of packs) {
      it(`pack "${p.name}" fits the ${PACKS_MAX}-char budget on its own, with nothing left out`, () => {
        const sel = selectPacks([p], REPRESENTATIVE[p.name]);
        expect(sel.omitted).toEqual([]);
        // An empty `omitted` alone would also hold if sections vanished: every section must be INCLUDED.
        expect(sel.included).toHaveLength(splitSections(p.body).sections.length);
        expect(sel.text.length).toBeLessThanOrEqual(PACKS_MAX);
      });
    }

    it('MEASURED GAP 2026-11-14: a T12 known-answer brief gets BOTH dispatch and hal-eval, not just the first', () => {
      const brief = 'Dispatch a T12 known-answer task to the swarm queue and measure HAL F1 on the corpus against the answer key';
      const matched = matchPacks(brief, packs);
      expect(matched.map((m: any) => m.name)).toEqual(expect.arrayContaining(['dispatch', 'hal-eval']));
      const sel = selectPacks(matched, brief);
      const injected = new Set(sel.included.map((s: any) => s.pack));
      for (const name of ['dispatch', 'hal-eval']) expect(injected.has(name)).toBe(true);
    });

    it('a brief matching every pack: each pack is injected, and every section is either injected or named as left out', () => {
      const brief = Object.values(REPRESENTATIVE).join(' ');
      const matched = matchPacks(brief, packs);
      expect(matched).toHaveLength(packs.length);
      const sel = selectPacks(matched, brief);
      for (const p of packs) {
        expect(sel.included.some((s: any) => s.pack === p.name)).toBe(true);
        const titles = splitSections(p.body).sections.map((s: any) => s.title);
        const accounted = [...sel.included, ...sel.omitted].filter((s: any) => s.pack === p.name).map((s: any) => s.title);
        expect(accounted.sort()).toEqual(titles.sort());
      }
      for (const o of sel.omitted) expect(sel.text).toContain(o.title); // named in the footer, not silently gone
    });

    it('packIndex lists every pack file with its section titles', () => {
      const idx = packIndex(packs);
      for (const p of packs) expect(idx).toContain(`lessons/${p.name}.md`);
    });
  });

  describe('selectPacks: budget without silent drops', () => {
    const big = (label: string, n: number) => ({ name: label, triggers: ['x'], body: label.repeat(n) });
    const sectioned = (name: string, sections: [string, string][]) => ({
      name, triggers: ['x'], body: [`# ${name}`, ...sections.map(([t, b]) => `## ${t}\n${b}`)].join('\n\n'),
    });

    it('includes every pack, untouched, when the combined size is under the cap (no footer)', () => {
      const small = [big('a', 10), big('b', 10)];
      expect(renderPacks(small, 1000)).toBe('aaaaaaaaaa\n\nbbbbbbbbbb');
    });

    it('a later pack that does not fit is NAMED in the footer and in `omitted`, never dropped silently', () => {
      const p1 = big('a', 100);
      const p2 = big('b', 950); // would take the total to 1054 with the joins
      const sel = selectPacks([p1, p2], '', 1000);
      expect(sel.text.startsWith(p1.body)).toBe(true);
      expect(sel.text).not.toContain('b'.repeat(50)); // not truncated in mid-pack either
      expect(sel.omitted).toEqual([{ pack: 'b', title: '(whole pack)' }]);
      expect(sel.text).toMatch(/left out for space[^]*\bb: \(whole pack\)/);
    });

    it('still includes a FIRST section that alone exceeds the cap — visibly too big, not silently empty', () => {
      const huge = big('a', 5000);
      const rendered = renderPacks([huge], 1000);
      expect(rendered).toBe(huge.body);
      expect(rendered.length).toBeGreaterThan(1000);
    });

    it('fills in rounds: two packs that cannot both fit whole each get their best section first', () => {
      const s = 'z'.repeat(400);
      const A = sectioned('alpha', [['A1', s], ['A2', s]]);
      const B = sectioned('beta', [['B1', s], ['B2', s]]);
      const sel = selectPacks([A, B], '', 1000);
      expect(sel.included.map((x: any) => `${x.pack}:${x.title}`).sort()).toEqual(['alpha:A1', 'beta:B1']);
      expect(sel.omitted.map((x: any) => x.title).sort()).toEqual(['A2', 'B2']);
    });

    it('ranks sections by the brief: the section that mentions the task wins the space', () => {
      const P = sectioned('pack', [['Unrelated', 'w'.repeat(600)], ['Known answers', 'grade every known-answer item against the commitment ' + 'v'.repeat(500)]]);
      const sel = selectPacks([P], 'grade the known-answer rehearsal against its commitment', 700);
      expect(sel.included.map((x: any) => x.title)).toEqual(['Known answers']);
      expect(sel.omitted.map((x: any) => x.title)).toEqual(['Unrelated']);
    });

    it('ranks packs by trigger hits: the pack the brief is mostly about goes first', () => {
      const P1 = { ...big('a', 600), name: 'one', triggers: ['alpha'] };
      const P2 = { ...big('b', 600), name: 'two', triggers: ['beta', 'gamma'] };
      const sel = selectPacks([P1, P2], 'beta gamma and a bit of alpha', 700);
      expect(sel.included.map((x: any) => x.pack)).toEqual(['two']);
      expect(sel.omitted.map((x: any) => x.pack)).toEqual(['one']);
    });

    it('a heading with no text still gets a visible name, so the footer never lists a blank', () => {
      const P = sectioned('pack', [['', 'x'.repeat(600)], ['Named', 'y'.repeat(600)]]);
      const sel = selectPacks([P], '', 700);
      expect([...sel.included, ...sel.omitted].map((s: any) => s.title)).toEqual(expect.arrayContaining(['(untitled section 1)', 'Named']));
      for (const o of sel.omitted) expect(o.title.trim()).not.toBe('');
    });

    it('splitSections keeps the intro apart and never splits a section', () => {
      const { intro, sections } = splitSections('# T\nintro line\n\n## One\nbody 1\n\n## Two\nbody 2');
      expect(intro).toBe('# T\nintro line');
      expect(sections.map((s: any) => s.title)).toEqual(['One', 'Two']);
      expect(sections[1].text).toBe('## Two\nbody 2');
    });
  });
});
