/**
 * HAL WS1.2a — CRAG ≥2-independent-source corroboration rule (the primary non-gameable lever).
 *
 * Proves the CRAG evaluator's layered defenses (src/hal/crag.ts, ANTIFRAGILE_PROVENANCE_PROGRAM_v0
 * §"Non-gameable CRAG"):
 *   1. TWO INDEPENDENT sources (different registrable domain) corroborating → grade 'Correct';
 *   2. a SINGLE source → grade 'Ambiguous' + disclosure_flag (single-source may not reach high conf);
 *   3. two SUBDOMAINS of the SAME owner count as ONE independent source → still 'Ambiguous'
 *      (a spoofer can't fake independence by spinning up a.example.com + b.example.com);
 *   4. layer (c) drops sources missing provenance metadata;
 *   5. registrableDomain() collapses ownership correctly (incl. multi-part suffixes like co.uk).
 *
 * Runs the DETERMINISTIC heuristic grader (no grader key present) so the corroboration lever is tested
 * with zero network + zero model dependency. Under the heuristic, an allow-listed source (domain prior
 * >= 0.75) is treated as weak 'supports'; the ≥2-DISTINCT-domain rule still gates the 'Correct' grade,
 * so the fallback can never over-confidently confirm on a single page.
 */
import { gradeEvidence, registrableDomain, domainPrior } from '../src/hal/crag';
import { contentHash, type EvidenceSnippet } from '../src/hal/retrieval';

/** Build a well-formed EvidenceSnippet with complete provenance for a given URL. */
function snippet(url: string, content: string): EvidenceSnippet {
  const domain = new URL(url).hostname.toLowerCase();
  return {
    content,
    source: 'firecrawl',
    rank: 0,
    provenance: { url, domain, timestamp: new Date().toISOString(), content_hash: contentHash(content) },
  };
}

// Force the deterministic heuristic path: remove any grader keys the test env may have loaded.
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['GROK_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('registrableDomain — ownership unit for independence', () => {
  it('collapses subdomains to the same registrable domain', () => {
    expect(registrableDomain('en.wikipedia.org')).toBe('wikipedia.org');
    expect(registrableDomain('a.example.com')).toBe('example.com');
    expect(registrableDomain('b.example.com')).toBe('example.com');
    expect(registrableDomain('en.wikipedia.org')).toBe(registrableDomain('de.wikipedia.org'));
  });
  it('handles multi-part public suffixes (co.uk)', () => {
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('foo.gov.uk')).toBe('foo.gov.uk');
  });
});

describe('domainPrior — allow/deny layer (a)', () => {
  it('gives allow-listed reference domains a high prior and unknowns a neutral one', () => {
    expect(domainPrior('wikipedia.org')).toBeGreaterThanOrEqual(0.75);
    expect(domainPrior('some-random-blog.example')).toBe(0.5);
  });
});

describe('CRAG ≥2-independent-source corroboration', () => {
  it('TWO INDEPENDENT supporting sources → Correct', async () => {
    const ev = [
      snippet('https://en.wikipedia.org/wiki/Paris', 'Paris is the capital of France.'),
      snippet('https://www.britannica.com/place/Paris', 'Paris, capital of France.'),
    ];
    const r = await gradeEvidence('Paris is the capital of France.', ev);
    expect(r.grader).toBe('heuristic'); // deterministic path — no model dependency
    expect(r.corroboration_count).toBe(2);
    expect(r.grade).toBe('Correct');
    expect(r.disclosure_flag).toBe(false);
  });

  it('SINGLE source → Ambiguous + disclosure_flag', async () => {
    const ev = [snippet('https://en.wikipedia.org/wiki/Paris', 'Paris is the capital of France.')];
    const r = await gradeEvidence('Paris is the capital of France.', ev);
    expect(r.corroboration_count).toBe(1);
    expect(r.grade).toBe('Ambiguous');
    expect(r.disclosure_flag).toBe(true);
  });

  it('two SUBDOMAINS of the SAME owner count as ONE independent source → Ambiguous', async () => {
    // Both allow-listed (bbc.co.uk) but the SAME registrable domain → not two independent owners.
    const ev = [
      snippet('https://news.bbc.co.uk/story/1', 'The claim is supported here.'),
      snippet('https://www.bbc.co.uk/story/2', 'The claim is supported here too.'),
    ];
    const r = await gradeEvidence('Some claim.', ev);
    expect(r.corroboration_count).toBe(1); // one registrable domain, not two
    expect(r.grade).toBe('Ambiguous');
    expect(r.disclosure_flag).toBe(true);
  });

  it('layer (c): a source missing provenance metadata is dropped before grading', async () => {
    const good = snippet('https://en.wikipedia.org/wiki/Paris', 'Paris is the capital of France.');
    const bad = snippet('https://www.britannica.com/place/Paris', 'Paris, capital of France.');
    // Corrupt the bad source's provenance (missing timestamp).
    (bad.provenance as any).timestamp = '';
    const r = await gradeEvidence('Paris is the capital of France.', [good, bad]);
    expect(r.dropped_for_provenance).toBe(1);
    expect(r.corroboration_count).toBe(1); // only the good source survived → single-source
    expect(r.grade).toBe('Ambiguous');
  });

  it('no usable evidence → Ambiguous (disclosure), never throws', async () => {
    const r = await gradeEvidence('Anything', []);
    expect(r.grade).toBe('Ambiguous');
    expect(r.disclosure_flag).toBe(true);
    expect(r.corroboration_count).toBe(0);
  });
});
