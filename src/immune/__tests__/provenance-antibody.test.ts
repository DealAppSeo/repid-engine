/**
 * provenance-antibody.test.ts — the antibody rejects a claim whose cited provenance does not resolve, and would
 * have caught the real 2026-11-03 T12 fabrication (a .js-citing audit against a .ts-only repo). Pure resolver
 * cases inject a FileView (no IO); the IO + end-to-end cases run against the real repo at process.cwd().
 */
import {
  resolveCitation,
  verifyCitations,
  extractCitations,
  type FileView,
  type Citation,
} from '../provenance-antibody';

const file = (over: Partial<FileView> = {}): FileView => ({ exists: true, lineCount: 100, text: '', ...over });
const cite = (over: Partial<Citation> = {}): Citation => ({ raw: 'x', path: 'src/x.ts', ...over });

describe('resolveCitation — the mechanical, un-collude-able ground truth (pure)', () => {
  it('resolves when the file exists and the line is in range', () => {
    expect(resolveCitation(cite({ line: 42 }), file()).resolved).toBe(true);
  });

  it('rejects a nonexistent path — the SY-15 shape (a .js file that does not exist)', () => {
    const r = resolveCitation(cite({ path: 'src/engine/config.js', line: 42 }), file({ exists: false, lineCount: 0 }));
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toBe('path_not_found:src/engine/config.js');
  });

  it('rejects a line past the end of the file', () => {
    const r = resolveCitation(cite({ line: 500 }), file({ lineCount: 100 }));
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toContain('line_out_of_range');
    expect((r as { reason: string }).reason).toContain('file has 100 lines');
  });

  it('refuses a path that escapes the repo root and is never read', () => {
    const r = resolveCitation(cite({ path: '../../../etc/passwd' }), file({ escaped: true, exists: false }));
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toBe('path_escapes_root:../../../etc/passwd');
  });

  it('resolves when the cited value actually appears at the cited line', () => {
    const f = file({ text: 'line1\nconst stakeAvailable = repid;\nline3', lineCount: 3 });
    expect(resolveCitation(cite({ line: 2, expect: 'const stakeAvailable = repid;' }), f).resolved).toBe(true);
  });

  it('rejects a cited value that is not at the citation (invented quote)', () => {
    const f = file({ text: 'line1\nconst stakeAvailable = repid;\nline3', lineCount: 3 });
    const r = resolveCitation(cite({ line: 2, expect: 'accuracy = 98.7%' }), f);
    expect(r.resolved).toBe(false);
    expect((r as { reason: string }).reason).toBe('value_not_at_citation:src/x.ts:2');
  });

  it('matches values whitespace-insensitively (quoting slips are not fabrication)', () => {
    const f = file({ text: 'a\nfoo(x)\nb', lineCount: 3 });
    expect(resolveCitation(cite({ line: 2, expect: 'foo( x )' }), f).resolved).toBe(true);
  });
});

describe('verifyCitations — IO against the real repo (path-safe)', () => {
  const root = process.cwd();

  it('resolves a real file in this repo and reports clean', () => {
    const res = verifyCitations([cite({ path: 'src/immune/provenance-antibody.ts' })], root);
    expect(res.clean).toBe(true);
    expect(res.resolved).toBe(1);
  });

  it('flags an invented .js path as path_not_found', () => {
    const res = verifyCitations([cite({ path: 'src/engine/config.js', line: 42 })], root);
    expect(res.clean).toBe(false);
    expect(res.unresolved[0]!.reason).toBe('path_not_found:src/engine/config.js');
  });

  it('refuses a traversal path without reading outside the root', () => {
    const res = verifyCitations([cite({ path: '../../../../etc/passwd' })], root);
    expect(res.clean).toBe(false);
    expect(res.unresolved[0]!.reason).toContain('path_escapes_root');
  });
});

describe('extractCitations — conservative front-end for free-text reports', () => {
  it('pulls code citations and ignores prose that merely looks dotted', () => {
    const got = extractCitations(
      'I audited src/engine/config.js:42 and src/hal/verifier.js. Version v1.0, 98.7% accuracy on trinity.ai.',
    );
    expect(got.map((c) => c.path)).toEqual(['src/engine/config.js', 'src/hal/verifier.js']);
    expect(got[0]!.line).toBe(42);
  });
});

describe('the real SY-15 fabrication is caught end to end', () => {
  // Representative of trinity-chesed's 2026-11-03 "SY-15 audit": confident prose citing .js files in a .ts-only repo.
  const fabricatedReport = `
    SY-15 Security Audit — COMPLETE. Reviewed the config loader at src/engine/config.js:88 and the HAL
    verifier src/hal/verifier.js:210. Both pass. Measured 98.7% accuracy across the suite. Signed off.
  `;

  it('extractor + verifier flag every cited .js file as nonexistent (clean = false)', () => {
    const res = verifyCitations(extractCitations(fabricatedReport), process.cwd());
    expect(res.checked).toBe(2);
    expect(res.clean).toBe(false);
    expect(res.unresolved.map((u) => u.reason)).toEqual([
      'path_not_found:src/engine/config.js',
      'path_not_found:src/hal/verifier.js',
    ]);
  });

  it('a report citing only real files resolves clean', () => {
    const honest = 'Looked at src/immune/provenance-antibody.ts and src/immune/config-pin.ts — both present.';
    const res = verifyCitations(extractCitations(honest), process.cwd());
    expect(res.checked).toBe(2);
    expect(res.clean).toBe(true);
  });
});
