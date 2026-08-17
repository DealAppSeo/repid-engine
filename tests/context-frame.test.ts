/**
 * Context Frame — the property under test is the ORDERING of a commitment against the action it
 * predicts. Reverse the order and these go red, which is the whole point of writing the check in
 * Phase 1 for a mechanism that is not wired until Phase 3: the Phase 3 promotion gate asks for a
 * test that fails when the order is reversed, and this is that test, available in advance.
 */
import {
  commitmentOrderFault,
  frameFaults,
  frameCompletion,
  Commitment,
  ContextFrame,
} from '../src/orchestration/context-frame';

const goodCommitment: Commitment = {
  hash: 'sha256:deadbeef',
  sealedAt: '2026-08-17T10:00:00.000Z',
  predictedOutcome: 'the claim will be vetoed',
  selfConfidence: 0.8,
};

const ACTION_AT = '2026-08-17T10:00:05.000Z';

describe('commitment ordering', () => {
  it('accepts a commitment sealed strictly before the action', () => {
    expect(commitmentOrderFault(goodCommitment, ACTION_AT)).toBeNull();
  });

  it('REFUSES a commitment sealed after the action — a prediction made after the fact is a description', () => {
    const late: Commitment = { ...goodCommitment, sealedAt: '2026-08-17T10:00:09.000Z' };
    const fault = commitmentOrderFault(late, ACTION_AT);
    expect(fault?.code).toBe('SEALED_AFTER_ACTION');
  });

  it('REFUSES a commitment sealed at the same instant as the action', () => {
    const simultaneous: Commitment = { ...goodCommitment, sealedAt: ACTION_AT };
    const fault = commitmentOrderFault(simultaneous, ACTION_AT);
    // Ambiguity is refused rather than permitted: a commitment stamped at the same instant is
    // indistinguishable from one written by the code path that performed the action.
    expect(fault?.code).toBe('SEALED_AT_ACTION');
  });

  it('refuses rather than guesses when a timestamp cannot be parsed', () => {
    expect(commitmentOrderFault({ ...goodCommitment, sealedAt: 'yesterday' }, ACTION_AT)?.code).toBe(
      'UNPARSEABLE_TIME',
    );
    expect(commitmentOrderFault(goodCommitment, 'soon')?.code).toBe('UNPARSEABLE_TIME');
  });

  it('rejects an empty hash — nothing is bound', () => {
    expect(commitmentOrderFault({ ...goodCommitment, hash: '  ' }, ACTION_AT)?.code).toBe('EMPTY_HASH');
  });

  it('rejects a self-confidence outside [0,1]', () => {
    expect(commitmentOrderFault({ ...goodCommitment, selfConfidence: 1.5 }, ACTION_AT)?.code).toBe(
      'CONFIDENCE_OUT_OF_RANGE',
    );
    expect(commitmentOrderFault({ ...goodCommitment, selfConfidence: -0.1 }, ACTION_AT)?.code).toBe(
      'CONFIDENCE_OUT_OF_RANGE',
    );
    expect(commitmentOrderFault({ ...goodCommitment, selfConfidence: NaN }, ACTION_AT)?.code).toBe(
      'CONFIDENCE_OUT_OF_RANGE',
    );
  });

  it('accepts the boundary values 0 and 1', () => {
    expect(commitmentOrderFault({ ...goodCommitment, selfConfidence: 0 }, ACTION_AT)).toBeNull();
    expect(commitmentOrderFault({ ...goodCommitment, selfConfidence: 1 }, ACTION_AT)).toBeNull();
  });
});

function frame(over: Partial<ContextFrame> = {}): ContextFrame {
  return {
    id: 'frame-1',
    goal: 'decide whether the claim is true',
    createdAt: '2026-08-17T09:00:00.000Z',
    hypotheses: [],
    commitments: [],
    budgets: [],
    provenance: [],
    completionCriteria: [{ id: 'c1', description: 'a verdict is written', met: true }],
    parents: [],
    ...over,
  };
}

describe('frame structure', () => {
  it('a frame with no completion criteria is an ERROR, not a flag', () => {
    const faults = frameFaults(frame({ completionCriteria: [] }));
    const noCriteria = faults.find((f) => f.code === 'NO_COMPLETION_CRITERIA');
    expect(noCriteria).toBeDefined();
    // Deliberately fatal: a surface that cannot say when an item is done is the shape of every
    // planning surface NORTH-STAR lists as deprecated.
    expect(noCriteria?.severity).toBe('error');
  });

  it('rejects an empty goal', () => {
    expect(frameFaults(frame({ goal: '   ' })).map((f) => f.code)).toContain('EMPTY_GOAL');
  });

  it('rejects duplicate criterion ids', () => {
    const faults = frameFaults(
      frame({
        completionCriteria: [
          { id: 'c1', description: 'a', met: null },
          { id: 'c1', description: 'b', met: null },
        ],
      }),
    );
    expect(faults.map((f) => f.code)).toContain('DUPLICATE_CRITERION_ID');
  });

  it('flags but does not refuse an exceeded budget', () => {
    const faults = frameFaults(frame({ budgets: [{ unit: 'usd', limit: 10, spent: 12 }] }));
    const budget = faults.find((f) => f.code === 'BUDGET_EXCEEDED');
    expect(budget?.severity).toBe('flag');
  });

  it('a clean frame has no faults', () => {
    expect(frameFaults(frame())).toHaveLength(0);
  });
});

describe('frame completion — three outcomes, never two', () => {
  it('VERIFIED only when every criterion was checked and passed', () => {
    expect(frameCompletion(frame())).toBe('VERIFIED');
  });

  it('NOT_CHECKED when any criterion was not looked at, even if all checked ones passed', () => {
    const f = frame({
      completionCriteria: [
        { id: 'c1', description: 'checked and passed', met: true },
        { id: 'c2', description: 'nobody looked', met: null },
      ],
    });
    // The failure this prevents is collapsing "we did not look" into "it passed".
    expect(frameCompletion(f)).toBe('NOT_CHECKED');
  });

  it('FAILED beats NOT_CHECKED — a known failure is more informative than an unfinished check', () => {
    const f = frame({
      completionCriteria: [
        { id: 'c1', description: 'failed', met: false },
        { id: 'c2', description: 'nobody looked', met: null },
      ],
    });
    expect(frameCompletion(f)).toBe('FAILED');
  });

  it('a frame with no criteria is NOT_CHECKED, never VERIFIED', () => {
    expect(frameCompletion(frame({ completionCriteria: [] }))).toBe('NOT_CHECKED');
  });
});
