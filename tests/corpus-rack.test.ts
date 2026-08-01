/**
 * The corpus rack is a RULER, and a ruler nobody can check is just a claim.
 *
 * HAL's F1 has been quoted at 0.34, 0.74, 0.886 and 0.890. Those are four
 * different rulers reported as one scale, which is why none of them settles
 * anything. A frozen, content-hashed corpus fixes that — but only if the gates
 * that keep it honest actually hold. So they are tested, not trusted.
 *
 * These tests run the real validator as a subprocess, the same way CI and a
 * human would, rather than importing its internals.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', 'scripts', 'corpus', 'hash-corpus.mjs');
const EXAMPLE = join(__dirname, '..', 'data', 'hal_corpus_v1', 'example.jsonl');

const row = (over: Record<string, string> = {}) => ({
  id: 'r1',
  prompt: 'Does water boil at 100C at sea level?',
  candidate_answer: 'Yes, at standard atmospheric pressure.',
  label: 'TRUE',
  category: 'physics',
  source_url: 'https://www.nist.gov/pml/water-boiling-point',
  source_retrieved_at: '2026-08-01T00:00:00Z',
  notes: 'test fixture',
  split: 'train',
  ...over,
});

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'corpus-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

/** Returns stdout on success, or throws with stderr attached on a non-zero exit. */
function run(rows: object[], name: string): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return execFileSync('node', [SCRIPT, file], { encoding: 'utf8' }).trim();
}

function runExpectingFailure(rows: object[], name: string): string {
  try {
    run(rows, name);
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return String(err.stderr ?? '') + String(err.stdout ?? '');
  }
  throw new Error('validator ACCEPTED a corpus it should have rejected');
}

describe('corpus rack — the hash', () => {
  it('is stable across row order and key order', () => {
    const a = run([row({ id: 'a' }), row({ id: 'b' })], 'order-1');
    // Same content, rows reversed and keys shuffled.
    const shuffled = [row({ id: 'b' }), row({ id: 'a' })].map((r) =>
      Object.fromEntries(Object.entries(r).reverse()),
    );
    const b = run(shuffled, 'order-2');
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a single label changes — the point of freezing it', () => {
    const before = run([row({ id: 'a' })], 'label-1');
    const after = run([row({ id: 'a', label: 'FALSE' })], 'label-2');
    expect(after).not.toEqual(before);
  });
});

describe('corpus rack — provenance gate', () => {
  it('rejects the shipped format example, so it can never be promoted by renaming it', () => {
    let out = '';
    try {
      execFileSync('node', [SCRIPT, EXAMPLE], { encoding: 'utf8' });
      throw new Error('validator ACCEPTED example.jsonl as a real corpus');
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      out = String(err.stderr ?? err.message);
    }
    expect(out).toMatch(/format-example placeholder/i);
  });

  it('rejects a row whose source is not a checkable URL', () => {
    expect(runExpectingFailure([row({ source_url: 'internal notes' })], 'src-1'))
      .toMatch(/absolute URL/i);
  });

  it('rejects a non-http source scheme', () => {
    expect(runExpectingFailure([row({ source_url: 'file:///C:/private/labels.txt' })], 'src-2'))
      .toMatch(/must be http/i);
  });

  it('accepts a row with a real, resolvable source', () => {
    expect(run([row()], 'src-ok')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('corpus rack — holdout leak gate', () => {
  it('rejects the same prompt+answer appearing in both splits', () => {
    const out = runExpectingFailure(
      [row({ id: 'train-1', split: 'train' }), row({ id: 'hold-1', split: 'holdout' })],
      'leak-1',
    );
    expect(out).toMatch(/HOLDOUT LEAK/);
  });

  it('allows the same prompt with a DIFFERENT candidate answer across splits', () => {
    // A contrast pair is legitimate and useful: same question, one good answer and
    // one hallucinated one. Only an identical pair is a leak.
    const out = run(
      [
        row({ id: 'train-1', split: 'train' }),
        row({ id: 'hold-1', split: 'holdout', candidate_answer: 'No, it boils at 90C.', label: 'FALSE' }),
      ],
      'leak-2',
    );
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});
