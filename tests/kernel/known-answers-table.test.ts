/**
 * Integrity test for the policy-kernel known-answer table (eval/kernel/known-answers.jsonl).
 *
 * This test is DELIBERATELY STANDALONE: it imports NOTHING from src/kernel (or anywhere in src).
 * It reads the JSONL off disk and validates its shape, so it runs and passes independently of
 * whether CC1's kernel branch is present, building, or merged. Its only dependencies are node
 * built-ins (fs/path) and jest globals.
 *
 * WHAT IT PROVES
 *   - Every row has EXACTLY the five required fields — no missing, no extra.
 *   - `hash` is 64 lowercase hex, and every hash is unique.
 *   - `label` and `role` are in their documented enums.
 *   - `checker_pair` is two DISTINCT family ids drawn from the real family set.
 *   - NO FIELD CONTAINS A SENTENCE. Mechanically: every string value anywhere in a row is free of
 *     whitespace and at most 64 chars. A plaintext question would violate both. This is how the
 *     "No sentence" hard rule is enforced rather than merely asserted.
 *
 * NON-VACUITY: a passing assertion is worthless if the checker cannot fail. The final block runs
 * the SAME validator over deliberately broken fixture rows (a smuggled plaintext sentence, a
 * duplicate hash, a missing field, an extra field, a bad enum, a one-element / twin-family pair,
 * a non-hex hash) and asserts each is REJECTED. If the validator ever stops catching these, this
 * block goes red — so a green table result means the test can discriminate, not just that it ran.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE_PATH = resolve(__dirname, '../../eval/kernel/known-answers.jsonl');

// Documented enums (see eval/kernel/README.md).
const LABELS = new Set(['TRUE', 'FALSE', 'UNVERIFIABLE']);
const ROLES = new Set(['seed', 'canary', 'holdout']);
// Real §7 disjointness families (src/decisioning/family-registry.ts KNOWN_FAMILIES) + 'grok'
// (the independent tiebreak family HAL folds into its quorum, src/hal/fact-check.ts).
const FAMILIES = new Set([
  'deepseek', 'llama', 'glm', 'kimi', 'gemini', 'mistral', 'qwen', 'openai', 'anthropic', 'grok',
]);
const REQUIRED_FIELDS = ['hash', 'label', 'checker_pair', 'date', 'role'] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STRING_LEN = 64; // longest legitimate value is the 64-hex hash; anything longer is prose
const WHITESPACE = /\s/;

type Row = Record<string, unknown>;

/** Collect every string value in a value tree (objects, arrays, scalars). */
function stringValues(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringValues(x, out);
  return out;
}

/** Validate ONE row in isolation. Returns a list of problems; [] means the row is well-formed. */
function validateRow(row: Row): string[] {
  const problems: string[] = [];

  // exact field set — no missing, no extra
  const keys = Object.keys(row).sort();
  const expected = [...REQUIRED_FIELDS].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    problems.push(`field set is [${keys.join(',')}], expected [${expected.join(',')}]`);
  }

  // no sentence: every string value whitespace-free and <= MAX_STRING_LEN
  for (const s of stringValues(row)) {
    if (WHITESPACE.test(s)) problems.push(`string value contains whitespace (len ${s.length})`);
    if (s.length > MAX_STRING_LEN) problems.push(`string value exceeds ${MAX_STRING_LEN} chars (len ${s.length})`);
  }

  // hash
  if (typeof row['hash'] !== 'string' || !HEX64.test(row['hash'] as string)) {
    problems.push(`hash is not 64-lowercase-hex`);
  }

  // label
  if (typeof row['label'] !== 'string' || !LABELS.has(row['label'] as string)) {
    problems.push(`label not in enum`);
  }

  // role
  if (typeof row['role'] !== 'string' || !ROLES.has(row['role'] as string)) {
    problems.push(`role not in enum`);
  }

  // date
  if (typeof row['date'] !== 'string' || !DATE_RE.test(row['date'] as string)) {
    problems.push(`date not YYYY-MM-DD`);
  }

  // checker_pair: exactly two DISTINCT known families
  const cp = row['checker_pair'];
  if (!Array.isArray(cp)) {
    problems.push(`checker_pair is not an array`);
  } else {
    if (cp.length !== 2) problems.push(`checker_pair has ${cp.length} elements, expected 2`);
    for (const fam of cp) {
      if (typeof fam !== 'string' || !FAMILIES.has(fam)) problems.push(`checker_pair member not a known family: ${String(fam)}`);
    }
    if (cp.length === 2 && cp[0] === cp[1]) problems.push(`checker_pair families are not distinct`);
  }

  return problems;
}

/** Validate the WHOLE table, including cross-row uniqueness of hashes. */
function validateTable(rows: Row[]): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push('table is empty');
  rows.forEach((r, i) => validateRow(r).forEach((p) => problems.push(`row ${i}: ${p}`)));
  const hashes = rows.map((r) => r['hash']);
  const unique = new Set(hashes);
  if (unique.size !== hashes.length) problems.push(`hashes not unique: ${hashes.length} rows, ${unique.size} distinct`);
  return problems;
}

function loadTable(): Row[] {
  const raw = readFileSync(TABLE_PATH, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l) as Row;
      } catch (e) {
        throw new Error(`line ${i + 1} is not valid JSON: ${(e as Error).message}`);
      }
    });
}

describe('policy-kernel known-answer table', () => {
  const rows = loadTable();

  it('loads a non-empty table of JSONL rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  it('is entirely well-formed (shape, enums, 64-hex, no-sentence, unique hashes)', () => {
    const problems = validateTable(rows);
    expect(problems).toEqual([]);
  });

  it('every hash is unique', () => {
    const hashes = rows.map((r) => r['hash']);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('every row carries exactly the five required fields', () => {
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual([...REQUIRED_FIELDS].sort());
    }
  });

  it('contains all three roles (seed, canary, holdout) and all rows are dated 2026-10-12', () => {
    const roles = new Set(rows.map((r) => r['role']));
    expect(roles).toEqual(new Set(['seed', 'canary', 'holdout']));
    for (const r of rows) expect(r['date']).toBe('2026-10-12');
  });

  it('checker_pair always names two distinct known families', () => {
    for (const r of rows) {
      const cp = r['checker_pair'] as unknown[];
      expect(Array.isArray(cp)).toBe(true);
      expect(cp.length).toBe(2);
      expect(cp[0]).not.toBe(cp[1]);
      for (const fam of cp) expect(FAMILIES.has(fam as string)).toBe(true);
    }
  });

  // ── NON-VACUITY: prove the validator REJECTS bad tables ─────────────────────────────────────
  describe('non-vacuity: the validator rejects deliberately-bad rows', () => {
    // A known-good baseline row the mutants are derived from (not from the committed file, so the
    // mutant fixtures live only in test memory and never touch the repo's hash-only table).
    const GOOD: Row = {
      hash: 'a'.repeat(64),
      label: 'TRUE',
      checker_pair: ['llama', 'glm'],
      date: '2026-10-12',
      role: 'seed',
    };

    it('sanity: the baseline good row passes', () => {
      expect(validateRow(GOOD)).toEqual([]);
    });

    const MUTANTS: Array<{ why: string; row: Row }> = [
      // the canary that matters most: a smuggled plaintext SENTENCE (has spaces, is long)
      // Synthetic sentences only — never a real row's plaintext; the point is that ANY string
      // with whitespace (or over 64 chars) is rejected, which is how "no sentence" is enforced.
      { why: 'plaintext sentence smuggled into a field', row: { ...GOOD, label: 'this label field holds a whole sentence with spaces' } },
      { why: 'plaintext sentence smuggled as an extra field', row: { ...GOOD, question: 'a smuggled plaintext field containing spaces and words' } as Row },
      { why: 'non-hex hash', row: { ...GOOD, hash: 'not-a-sha256-hash' } },
      { why: 'uppercase-hex hash (not lowercase)', row: { ...GOOD, hash: 'A'.repeat(64) } },
      { why: 'short hash', row: { ...GOOD, hash: 'a'.repeat(63) } },
      { why: 'label not in enum', row: { ...GOOD, label: 'MAYBE' } },
      { why: 'role not in enum', row: { ...GOOD, role: 'training' } },
      { why: 'bad date', row: { ...GOOD, date: '10/12/2026' } },
      { why: 'missing a required field', row: (() => { const r = { ...GOOD }; delete (r as Row)['role']; return r; })() },
      { why: 'extra field', row: { ...GOOD, extra: 'x' } },
      { why: 'checker_pair with one element', row: { ...GOOD, checker_pair: ['llama'] } },
      { why: 'checker_pair with twin families', row: { ...GOOD, checker_pair: ['llama', 'llama'] } },
      { why: 'checker_pair with an unknown family', row: { ...GOOD, checker_pair: ['llama', 'notafamily'] } },
      { why: 'checker_pair not an array', row: { ...GOOD, checker_pair: 'llama,glm' } },
    ];

    it.each(MUTANTS)('rejects: $why', ({ row }) => {
      expect(validateRow(row).length).toBeGreaterThan(0);
    });

    it('rejects a table with a DUPLICATE hash across rows', () => {
      const dup: Row[] = [
        { ...GOOD },
        { ...GOOD, checker_pair: ['deepseek', 'gemini'], role: 'canary' }, // same hash, different metadata
      ];
      const problems = validateTable(dup);
      expect(problems.some((p) => p.includes('hashes not unique'))).toBe(true);
    });

    it('rejects an empty table', () => {
      expect(validateTable([]).some((p) => p.includes('empty'))).toBe(true);
    });
  });
});
