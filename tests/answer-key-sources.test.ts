/**
 * The answer key's record sources (S46): three outcomes, never two, and only a re-checkable record
 * decides. The Wikidata cases replay the exact bodies read on 2026-10-06
 * (eval/answer-key/relay-2026-10-06.json, each sha256-checked against the bytes Wikidata sent), so the
 * committed run is reproduced offline from what was actually read.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKERS, checkSpec, matches, referenced, statementValue } from '../src/answer-key/sources';
import type { ClaimSpec, FetchLike } from '../src/answer-key/types';

const RELAY = JSON.parse(readFileSync(join(__dirname, '../eval/answer-key/relay-2026-10-06.json'), 'utf8')) as Record<
  string,
  { status: number; body: string }
>;
const NOW = () => new Date('2026-10-06T17:00:00Z');
const ENV = {}; // no key, no boundary

type Reply = { status: number; body: string } | Error;
function host(routes: Record<string, Reply>, seen: string[] = []): FetchLike {
  return async (url) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw Object.assign(new Error('no route'), { name: 'TypeError' });
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body };
  };
}
const replay: FetchLike = host(RELAY);
const check = (spec: ClaimSpec, fetch: FetchLike = replay, env: Record<string, string | undefined> = ENV) =>
  checkSpec(spec, { fetch, now: NOW, env });

describe('every relayed body is the bytes Wikidata sent (sha256 pinned at the source)', () => {
  it('13 bodies, none edited', () => {
    expect(Object.keys(RELAY)).toHaveLength(13);
    const ein = RELAY['https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q513&property=P2044&format=json']!.body;
    expect(createHash('sha256').update(ein).digest('hex')).toBe('8c271be117bfc7082a7b8ddbfb63e7ea5764bd4feb188f72d0b80dec88efe6bf');
  });
});

describe('Wikidata, from the 2026-10-06 bodies', () => {
  const wd = (entity: string, property: string, expected: object, single: boolean) =>
    ({ kind: 'wikidata', entity, property, expected, single }) as ClaimSpec;

  it('supports: Python first released 1991 (referenced to docs.python.org)', async () => {
    const f = await check(wd('Q28865', 'P571', { type: 'year', year: 1991 }, true));
    expect(f).toMatchObject({ outcome: 'supports', checker: CHECKERS.wikidata });
    expect(f.record).toMatchObject({ kind: 'wikidata', locator: 'wikidata:Q28865#P571@rev2552516183' });
    expect(f.record!.url).toBe('https://www.wikidata.org/wiki/Special:EntityData/Q28865.json?revision=2552516183');
  });

  it('contradicts: Microsoft founded 1976, when the referenced value is 1975', async () => {
    const f = await check(wd('Q2283', 'P571', { type: 'year', year: 1976 }, true));
    expect(f.outcome).toBe('contradicts');
    expect(f.reason).toContain('1975');
  });

  it('contradicts: Australia\'s capital is Sydney, when the preferred referenced value is Canberra', async () => {
    const f = await check(wd('Q408', 'P36', { type: 'item', id: 'Q3130' }, true));
    expect(f.outcome).toBe('contradicts');
    expect(f.reason).toContain('Q3114');
    // Best rank only: Melbourne (1901-1927, normal rank) is not what the current statement says.
    expect((f.record!.snapshot.values as unknown[]).length).toBe(1);
  });

  it('a past capital is not the capital: Melbourne does not pass on a normal-rank statement', async () => {
    expect((await check(wd('Q408', 'P36', { type: 'item', id: 'Q3141' }, true))).outcome).toBe('contradicts');
  });

  it('unchecked: a matching value with no reference (Attention Is All You Need, 2017)', async () => {
    const f = await check(wd('Q30249683', 'P577', { type: 'year', year: 2017 }, true));
    expect(f.outcome).toBe('unchecked');
    expect(f.reason).toContain('no reference');
    expect(f.record).toBeDefined(); // the record was read and is kept
  });

  it('unchecked: a value whose only reference is an import note (On the Origin of Species, 1859)', async () => {
    const f = await check(wd('Q20124', 'P577', { type: 'year', year: 1859 }, true));
    expect(f.outcome).toBe('unchecked');
    expect(f.reason).toContain('imported from');
  });

  it('supports: Everest 8,848.86 m, compared in metres; the deprecated 29,030 ft never counts', async () => {
    const f = await check(wd('Q513', 'P2044', { type: 'quantity', amount: 8848.86, tolerance: 0.5, unit: 'Q11573' }, false));
    expect(f.outcome).toBe('supports');
  });

  it('a quantity in another unit is not compared: asking in feet finds nothing to decide on', async () => {
    const f = await check(wd('Q513', 'P2044', { type: 'quantity', amount: 29030, tolerance: 1, unit: 'Q3710' }, true));
    expect(f.outcome).toBe('unchecked');
  });

  it('a property that may hold many values never contradicts: a miss is unchecked', async () => {
    const f = await check(wd('Q513', 'P2044', { type: 'quantity', amount: 9000, tolerance: 1, unit: 'Q11573' }, false));
    expect(f.outcome).toBe('unchecked');
  });
});

describe('Wikidata, edge cases', () => {
  const info = (id: string) => ({ status: 200, body: JSON.stringify({ entities: { [id]: { id, lastrevid: 7 } } }) });
  const claimsUrl = (id: string, p: string) => `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${id}&property=${p}&format=json`;
  const infoUrl = (id: string) => `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&props=info&format=json`;
  const spec = { kind: 'wikidata', entity: 'Q1', property: 'P569', expected: { type: 'year', year: 1900 }, single: true } as ClaimSpec;

  it('a missing entity is unchecked', async () => {
    const f = await check(spec, host({ [infoUrl('Q1')]: { status: 200, body: JSON.stringify({ entities: { Q1: { id: 'Q1', missing: '' } } }) } }));
    expect(f.outcome).toBe('unchecked');
  });

  it('a merged item is followed to its target, and the record names the target', async () => {
    const seen: string[] = [];
    const f = await check(
      spec,
      host(
        {
          [infoUrl('Q1')]: info('Q2'),
          [claimsUrl('Q2', 'P569')]: { status: 200, body: JSON.stringify({ claims: { P569: [] } }) },
        },
        seen,
      ),
    );
    expect(seen[1]).toBe(claimsUrl('Q2', 'P569'));
    expect(f.record!.locator).toBe('wikidata:Q2#P569@rev7');
    expect(f.outcome).toBe('unchecked'); // no statement
  });

  it('a 5xx, a non-JSON body, a dropped connection: unchecked, never a verdict', async () => {
    for (const r of [{ status: 503, body: '' }, { status: 200, body: '<html>' }, new Error('reset')]) {
      expect((await check(spec, host({ [infoUrl('Q1')]: r as Reply }))).outcome).toBe('unchecked');
    }
  });

  it('an invalid id is refused before anything is fetched', async () => {
    const seen: string[] = [];
    const f = await check({ ...spec, entity: 'Q1 OR 1=1' } as ClaimSpec, host({}, seen));
    expect(f.outcome).toBe('unchecked');
    expect(seen).toHaveLength(0);
  });

  it('statementValue and matches read only typed values', () => {
    const time = { mainsnak: { snaktype: 'value', datavalue: { type: 'time', value: { time: '-0044-03-15T00:00:00Z', precision: 11 } } } };
    expect(statementValue(time)).toBe('-44');
    expect(matches(time, { type: 'year', year: -44 })).toBe(true);
    const coarse = { mainsnak: { snaktype: 'value', datavalue: { type: 'time', value: { time: '+1900-00-00T00:00:00Z', precision: 7 } } } };
    expect(statementValue(coarse)).toBeNull(); // a century has no year to compare
    expect(matches({ mainsnak: { snaktype: 'novalue' } }, { type: 'year', year: 1 })).toBeNull();
    expect(referenced({ references: [{ snaks: { P143: [] } }] })).toBe(false);
    expect(referenced({ references: [{ snaks: { P143: [], P854: [] } }] })).toBe(true);
  });
});

describe('npm and PyPI', () => {
  const npm = (name: string, body: object | null, status = 200): Record<string, Reply> => ({
    [`https://registry.npmjs.org/${name.replace('/', '%2f')}`]: { status, body: body ? JSON.stringify(body) : '{"error":"Not found"}' },
  });
  const doc = { name: 'express', 'dist-tags': { latest: '5.2.1' }, versions: { '4.18.2': {}, '5.2.1': {} } };

  it('a published version supports "exists", and an unpublished one contradicts it', async () => {
    const f = await check({ kind: 'npm-package', name: 'express', version: '4.18.2', asserts: 'exists' }, host(npm('express', doc)));
    expect(f).toMatchObject({ outcome: 'supports', checker: CHECKERS.npm });
    expect(f.record!.snapshot).toMatchObject({ latest: '5.2.1', hasVersion: true, versions: 2 });
    expect((await check({ kind: 'npm-package', name: 'express', version: '9.9.9', asserts: 'exists' }, host(npm('express', doc)))).outcome).toBe('contradicts');
  });

  it('a 404 is the registry saying it is absent: contradicts "exists", supports "absent"', async () => {
    const r = npm('made-up-pkg', null, 404);
    expect((await check({ kind: 'npm-package', name: 'made-up-pkg', asserts: 'exists' }, host(r))).outcome).toBe('contradicts');
    expect((await check({ kind: 'npm-package', name: 'made-up-pkg', asserts: 'absent' }, host(r))).outcome).toBe('supports');
  });

  it('scoped names are encoded, and a 5xx or a refusal is unchecked, never absent', async () => {
    const seen: string[] = [];
    await check({ kind: 'npm-package', name: '@hyperdag/trustshell', asserts: 'exists' }, host({}, seen));
    expect(seen[0]).toBe('https://registry.npmjs.org/@hyperdag%2ftrustshell');
    for (const status of [403, 500, 503]) {
      expect((await check({ kind: 'npm-package', name: 'express', asserts: 'exists' }, host(npm('express', doc, status)))).outcome).toBe('unchecked');
    }
  });

  it('an invalid name or version is refused before anything is fetched', async () => {
    const seen: string[] = [];
    for (const spec of [
      { kind: 'npm-package', name: '../etc/passwd', asserts: 'exists' },
      { kind: 'npm-package', name: 'Express', asserts: 'exists' },
      { kind: 'npm-package', name: 'express', version: 'latest', asserts: 'exists' },
      { kind: 'pypi-package', name: 'requests/../x', asserts: 'exists' },
    ] as ClaimSpec[]) {
      expect((await check(spec, host({}, seen))).outcome).toBe('unchecked');
    }
    expect(seen).toHaveLength(0);
  });

  it('PyPI: a release key decides, a 404 is absent', async () => {
    const r: Record<string, Reply> = {
      'https://pypi.org/pypi/requests/json': { status: 200, body: JSON.stringify({ info: { version: '2.34.2' }, releases: { '2.31.0': [], '2.34.2': [] } }) },
      'https://pypi.org/pypi/nope-pkg/json': { status: 404, body: '{"message":"Not Found"}' },
    };
    expect((await check({ kind: 'pypi-package', name: 'requests', version: '2.31.0', asserts: 'exists' }, host(r))).outcome).toBe('supports');
    expect((await check({ kind: 'pypi-package', name: 'requests', version: '3.0.0', asserts: 'exists' }, host(r))).outcome).toBe('contradicts');
    expect((await check({ kind: 'pypi-package', name: 'nope-pkg', asserts: 'exists' }, host(r))).outcome).toBe('contradicts');
  });
});

describe('published fact-checks are related records, never a verdict', () => {
  const spec = { kind: 'claimreview', query: 'Einstein insanity same thing over and over' } as ClaimSpec;

  it('no key: nothing is searched, and it says NOT CHECKED', async () => {
    const seen: string[] = [];
    const f = await check(spec, host({}, seen), {});
    expect(f.outcome).toBe('unchecked');
    expect(f.reason).toContain('NOT CHECKED');
    expect(seen).toHaveLength(0);
  });

  it('with a key: reviews found are attached, the outcome stays unchecked, and the key is never stored', async () => {
    const key = 'test-key-not-real';
    const seen: string[] = [];
    const fetch: FetchLike = async (url) => {
      seen.push(url);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({ claims: [{ text: 'Einstein said insanity is...', claimReview: [{ publisher: { site: 'example.org' }, url: 'https://example.org/r', textualRating: 'False' }] }] }),
      };
    };
    const f = await check(spec, fetch, { GOOGLE_FACT_CHECK_API_KEY: key });
    expect(seen[0]).toContain(`key=${key}`);
    expect(f.outcome).toBe('unchecked');
    expect(f.reason).toContain("a person's call");
    expect(JSON.stringify(f.record)).not.toContain(key);
    expect((f.record!.snapshot.reviews as Array<{ reviews: Array<{ rating: string }> }>)[0]!.reviews[0]!.rating).toBe('False');
  });
});

describe('ONLY_ATTESTATIONS_LEAVE: nothing is fetched at all', () => {
  it('every kind is unchecked, with no request made', async () => {
    const seen: string[] = [];
    for (const spec of [
      { kind: 'npm-package', name: 'express', asserts: 'exists' },
      { kind: 'wikidata', entity: 'Q1', property: 'P1', expected: { type: 'year', year: 1 }, single: true },
    ] as ClaimSpec[]) {
      const f = await check(spec, host({}, seen), { ONLY_ATTESTATIONS_LEAVE: 'true' });
      expect(f.outcome).toBe('unchecked');
    }
    expect(seen).toHaveLength(0);
  });
});
