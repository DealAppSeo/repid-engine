/**
 * Existing plonky3_range_check fixture. Honest proof verifies. One flipped byte fails.
 * No new circuit.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyRangeCheck } from '../src/zkp/range-check-verify';

describe('e2e zk agent range check', () => {
  const fixDir = path.join(__dirname, 'fixtures', 'zkp');

  it('verifies the synthetic fixture and rejects one flipped byte', () => {
    const meta = JSON.parse(
      readFileSync(path.join(fixDir, 'leaf-rangecheck.synthetic.json'), 'utf8'),
    ) as {
      scheme: string;
      SYNTHETIC: boolean;
      proof_file: string;
      proof_bytes_len: number;
      statement: Record<string, unknown>;
    };
    expect(meta.scheme).toBe('plonky3_range_check');
    expect(meta.SYNTHETIC).toBe(true);

    const proof = readFileSync(path.join(fixDir, meta.proof_file));
    expect(proof.length).toBe(meta.proof_bytes_len);

    const honest = verifyRangeCheck(proof.toString('base64'), meta.statement);
    expect(honest.verified).toBe(true);
    expect(honest.scheme).toBe('plonky3_range_check');

    const flipped = Buffer.from(proof);
    const first = flipped[0] ?? 0;
    flipped[0] = first ^ 0x01;
    expect(flipped.equals(proof)).toBe(false);
    const rejected = verifyRangeCheck(flipped.toString('base64'), meta.statement);
    expect(rejected.verified).toBe(false);
    expect(rejected.scheme).toBe('plonky3_range_check');
  }, 120000);
});
