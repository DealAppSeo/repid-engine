/**
 * The real corpus files, checked against the real validator.
 *
 * THE GAP THIS CLOSES. tests/corpus-rack.test.ts passes 8/8 — but it exercises
 * the validator against synthetic fixtures it writes itself. Nothing pointed the
 * validator at the corpora actually shipped in this repo. When someone finally
 * did, all three failed their own schema outright, so `hash-corpus.mjs` had never
 * emitted a hash for any of them, and every HAL F1 quoted to date (0.34 / 0.74 /
 * 0.886 / 0.890) was taken on an unfrozen ruler.
 *
 * A well-tested validator with nothing to validate is the same shape as the rest
 * of this codebase's recurring bug: a mechanism that exists, is correct, and has
 * no callers. This file is the caller.
 *
 * WHY IT EXPIRES BY ITSELF. It re-derives each hash from the file on disk and
 * compares against MANIFEST.json. Change one label and the hash moves, so the
 * manifest must be updated in the same commit — the corpus cannot drift quietly.
 * The manifest is not the source of truth; the files are. The manifest is the
 * claim, and this test is what makes the claim falsifiable.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const HASHER = join(ROOT, 'scripts', 'corpus', 'hash-corpus.mjs');
const MANIFEST_PATH = join(ROOT, 'data', 'hal_corpus_v1', 'MANIFEST.json');

interface CorpusEntry {
  name: string;
  path: string;
  sha256: string;
  rows: number;
  labels: Record<string, number>;
  splits: Record<string, number>;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { corpora: CorpusEntry[] };

/** Runs the same validator+hasher CI runs, as a subprocess, exactly as a human would. */
function hashOf(relPath: string): string {
  const out = execFileSync('node', [HASHER, join(ROOT, relPath)], { encoding: 'utf8' });
  return out.trim().split('\n').pop()!.trim();
}

describe('HAL corpus manifest', () => {
  it('lists at least one corpus', () => {
    // Without this the whole file would pass vacuously over an empty array —
    // the precise failure mode being fixed elsewhere in this repo today.
    expect(Array.isArray(manifest.corpora)).toBe(true);
    expect(manifest.corpora.length).toBeGreaterThan(0);
  });

  it.each(manifest.corpora.map((c) => [c.name, c] as const))('%s: file exists', (_name, c) => {
    expect(existsSync(join(ROOT, c.path))).toBe(true);
  });

  it.each(manifest.corpora.map((c) => [c.name, c] as const))(
    '%s: passes the schema validator and matches its recorded hash',
    (_name, c) => {
      // A validation failure makes the hasher exit non-zero, so execFileSync
      // throws and this fails with the validator's own per-row reasons.
      const actual = hashOf(c.path);
      expect(actual).toMatch(/^[0-9a-f]{64}$/);
      expect(actual).toBe(c.sha256);
    },
    30_000,
  );

  it.each(manifest.corpora.map((c) => [c.name, c] as const))(
    '%s: row count, label balance and split sizes match the manifest',
    (_name, c) => {
      const rows = readFileSync(join(ROOT, c.path), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { label: string; split: string });

      expect(rows.length).toBe(c.rows);

      const labels: Record<string, number> = {};
      const splits: Record<string, number> = {};
      for (const r of rows) {
        labels[r.label] = (labels[r.label] ?? 0) + 1;
        splits[r.split] = (splits[r.split] ?? 0) + 1;
      }
      expect(labels).toEqual(c.labels);
      expect(splits).toEqual(c.splits);
    },
  );

  it.each(manifest.corpora.map((c) => [c.name, c] as const))(
    '%s: holdout is non-empty and both labels survive into it',
    (_name, c) => {
      // A holdout that is empty, or that lost a class, silently turns an F1 into
      // a number about the training set. Cheap to check, expensive to miss.
      const rows = readFileSync(join(ROOT, c.path), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { label: string; split: string });
      const holdout = rows.filter((r) => r.split === 'holdout');
      expect(holdout.length).toBeGreaterThan(0);
      expect(new Set(holdout.map((r) => r.label)).size).toBeGreaterThan(1);
    },
  );
});
