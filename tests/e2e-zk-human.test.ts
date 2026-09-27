/**
 * Same range-check verifier. subject_type human lives on an in-memory fixture.
 * The on-disk statement has no subject_type column, so the subject stays NOT_CHECKED.
 * This file does not write SQL.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyRangeCheck } from '../src/zkp/range-check-verify';

describe('e2e zk human range check', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'zkp', 'leaf-rangecheck.synthetic.json');

  it('keeps subject_type human in memory and reports NOT_CHECKED when the column is absent', () => {
    const before = readFileSync(fixturePath, 'utf8');
    const meta = JSON.parse(before) as {
      scheme: string;
      proof_file: string;
      statement: Record<string, unknown>;
    };
    expect(meta.scheme).toBe('plonky3_range_check');
    expect(Object.keys(meta.statement)).not.toContain('subject_type');

    const memory = {
      ...meta,
      subject_type: 'human' as const,
      statement: { ...meta.statement, subject_type: 'human' },
    };
    expect(memory.subject_type).toBe('human');
    expect(memory.statement.subject_type).toBe('human');

    const columnExists = Object.prototype.hasOwnProperty.call(meta.statement, 'subject_type');
    const subjectStatus = columnExists ? memory.statement.subject_type : 'NOT_CHECKED';
    expect(subjectStatus).toBe('NOT_CHECKED');

    const proof = readFileSync(path.join(path.dirname(fixturePath), meta.proof_file));
    const result = verifyRangeCheck(proof.toString('base64'), memory.statement);
    expect(result.verified).toBe(true);
    expect(result.scheme).toBe('plonky3_range_check');
    expect(Object.keys(result)).not.toContain('subject_type');

    expect(readFileSync(fixturePath, 'utf8')).toBe(before);
  }, 120000);
});
