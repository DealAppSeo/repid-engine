import {
  canonicalize, computeCommitHash, merkleRoot, e1SchemaUid, buildAttestation,
  type PreRegistrationBundle,
} from '../src/services/e1-commit-reveal';

const BUNDLE: PreRegistrationBundle = {
  preRegistration: { hypothesis: 'verdict mode reduces opinion over-veto', primary_metric: 'opinion_veto_rate' },
  taskSet: ['task-001', 'task-002', 'task-003'],
  seeds: [11, 22, 33],
  analysisCodeHash: '0xabc123',
};

describe('E1 commit-reveal (P2)', () => {
  test('canonicalize is key-order-independent (deterministic commitment)', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } });
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  test('commit hash is deterministic + sensitive to any change', () => {
    const h1 = computeCommitHash(BUNDLE);
    const h2 = computeCommitHash({ ...BUNDLE });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    const tampered = computeCommitHash({ ...BUNDLE, seeds: [11, 22, 34] });
    expect(tampered).not.toBe(h1);
  });

  test('merkle root: deterministic, order-sensitive, handles odd count', () => {
    const leaves = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32)];
    const r1 = merkleRoot(leaves);
    expect(r1).toBe(merkleRoot([...leaves]));
    expect(r1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(merkleRoot([leaves[2], leaves[1], leaves[0]])).not.toBe(r1); // order-sensitive
    expect(merkleRoot([])).toBe('0x' + '0'.repeat(64));                  // empty
    expect(merkleRoot([leaves[0]])).toBe(leaves[0]);                     // single leaf = itself
  });

  test('schema UID is stable', () => {
    expect(e1SchemaUid()).toBe(e1SchemaUid());
    expect(e1SchemaUid()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('COMMIT plan: refUID is zero, data encodes, cast command present', () => {
    const commitHash = computeCommitHash(BUNDLE);
    const plan = buildAttestation({ phase: 'COMMIT', runId: 'run-1', rootHash: commitHash, timestamp: 1_780_000_000 });
    expect(plan.refUID).toBe('0x' + '0'.repeat(64));
    expect(plan.rootHash).toBe(commitHash);
    expect(plan.encodedData).toMatch(/^0x[0-9a-f]+$/);
    expect(plan.castCommand).toContain('cast send');
    expect(plan.castCommand).toContain(plan.schemaUid);
  });

  test('REVEAL plan: must reference the commit uid; links via refUID', () => {
    const commitUID = '0x' + 'ab'.repeat(32);
    const root = merkleRoot(['0x' + '44'.repeat(32), '0x' + '55'.repeat(32)]);
    const plan = buildAttestation({ phase: 'REVEAL', runId: 'run-1', rootHash: root, timestamp: 1_780_000_100, commitUID });
    expect(plan.refUID).toBe(commitUID);
    // a REVEAL without a commit uid is rejected (can't reveal what was never committed).
    expect(() => buildAttestation({ phase: 'REVEAL', runId: 'run-1', rootHash: root, timestamp: 1 })).toThrow(/COMMIT uid/);
  });
});
