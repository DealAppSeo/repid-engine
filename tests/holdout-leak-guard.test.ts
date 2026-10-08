/**
 * THE HOLDOUT LEAK GUARD (S60, 2026-10-07): private holdout text must never enter git.
 *
 * eval/holdout/manifest.jsonl holds sha256(normalized claim) for every private item. This test
 * hashes every candidate sentence in every committed file (plus untracked files git does not
 * ignore, i.e. what the next commit could carry) the same way, and fails if any manifest hash
 * turns up. That is the mechanical half: no reviewer has to notice a sentence in a fixture.
 *
 * AN EMPTY SCAN MUST FAIL, NOT PASS (LESSONS rule 5). So the test asserts it read a non-trivial
 * number of files and sentences, and it carries one POSITIVE CONTROL per format: a sentence known to
 * be committed as a JSONL field, a JSON string, a TypeScript literal, a SQL literal and a markdown
 * table cell. If the scanner stops reading a format, that control goes missing and this fails.
 * A synthetic plant in a temp directory proves a watched hash is actually reported.
 *
 * What it cannot see: a paraphrase, or a sentence split across lines. Hash matching finds copies.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { claimSha256, readManifest, REPO_ROOT } from '../scripts/eval/holdout';
import { scanFiles, scanRepo, type ScanResult } from '../scripts/eval/holdout-leak-scan';

const FILE_FLOOR = 1000;
const CANDIDATE_FLOOR = 100_000;

interface Control {
  format: string;
  file: string;
  sentence: string;
}

function firstJsonl<T>(rel: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n').find((l) => l.trim())!) as T;
}

/** One committed sentence per format, read from the file itself so a control cannot drift. */
function controls(): Control[] {
  const canaryRaw = readdirSync(join(REPO_ROOT, 'reports', '2026-07-07')).find((f) => /^canary-f1-raw-.*\.json$/.test(f))!;
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'reports', '2026-07-07', canaryRaw), 'utf8')) as { results: Array<{ claim: string }> };
  const seed = firstJsonl<{ claim: string }>('eval/answer-key/seed-2026-10-06.jsonl');
  return [
    { format: 'jsonl', file: 'data/hal_corpus_v1/rigorous-v1.jsonl', sentence: firstJsonl<{ candidate_answer: string }>('data/hal_corpus_v1/rigorous-v1.jsonl').candidate_answer },
    { format: 'json', file: `reports/2026-07-07/${canaryRaw}`, sentence: raw.results[0]!.claim },
    { format: 'ts', file: 'tests/hal-frozen-corpus-offline-eval.test.ts', sentence: 'The moon is definitely made of green cheese and this is 100% certain.' },
    { format: 'sql', file: 'eval/answer-key/run-2026-10-06.sql', sentence: seed.claim },
    { format: 'md', file: 'eval/answer-key/README.md', sentence: '*Attention Is All You Need* is arXiv 1810.04805, first posted in 2018' },
  ];
}

describe('holdout leak guard — no private holdout sentence in any committed file', () => {
  const ctl = controls();
  const manifest = readManifest();
  let scan: ScanResult;

  beforeAll(() => {
    const watch = new Set([...manifest.map((r) => r.claim_sha256), ...ctl.map((c) => claimSha256(c.sentence))]);
    scan = scanRepo(REPO_ROOT, watch);
  }, 180_000);

  it('scanned a non-trivial tree (an empty scan fails here, it does not pass)', () => {
    expect(scan.files).toBeGreaterThanOrEqual(FILE_FLOOR);
    expect(scan.candidates).toBeGreaterThanOrEqual(CANDIDATE_FLOOR);
    for (const ext of ['.ts', '.json', '.jsonl', '.sql', '.md']) expect(scan.byExt[ext] ?? 0).toBeGreaterThan(0);
  });

  it.each(controls().map((c) => [c.format, c] as const))('positive control (%s): a committed sentence is found where it lives', (_f, c) => {
    const where = scan.hits.get(claimSha256(c.sentence)) ?? [];
    expect(where).toContain(c.file);
  });

  it('no manifest claim hash appears in any committed or committable file', () => {
    const leaked = manifest
      .filter((r) => scan.hits.has(r.claim_sha256))
      .map((r) => `${r.item_id} in ${scan.hits.get(r.claim_sha256)!.join(', ')}`);
    // A hit means that item's text is public: retire it (holdout-rotate.ts) and remove the copy.
    expect(leaked).toEqual([]);
  });
});

describe('holdout leak guard — the scanner reports a planted sentence (synthetic, temp dir)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'leak-guard-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('finds one synthetic sentence planted as a JSON value, a TS literal, a SQL literal and a table cell', () => {
    const s = `Synthetic planted sentence ${randomBytes(6).toString('hex')} is not real at all.`;
    const sqlEscaped = s.replace('not', "isn''t really not");
    const sql = sqlEscaped.replace(/''/g, "'");
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ rows: [{ text: s }] }));
    writeFileSync(join(dir, 'b.ts'), `const x = { claim: '${s.replace(/'/g, "\\'")}', n: 1 };\n`);
    writeFileSync(join(dir, 'c.sql'), `insert into t (claim) values ('${sqlEscaped}');\n`);
    writeFileSync(join(dir, 'd.md'), `| 3 | FP | **${s.toUpperCase()}** | flagged |\n`);
    writeFileSync(join(dir, 'e.bin'), Buffer.from([0, 1, 2, 3]));
    const res = scanFiles(dir, ['a.json', 'b.ts', 'c.sql', 'd.md', 'e.bin'], new Set([claimSha256(s), claimSha256(sql)]));
    expect(res.hits.get(claimSha256(s))?.sort()).toEqual(['a.json', 'b.ts', 'd.md']);
    expect(res.hits.get(claimSha256(sql))).toEqual(['c.sql']);
    expect(res.skipped).toBe(1);
  });
});
