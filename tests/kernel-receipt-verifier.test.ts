/**
 * kernel-receipt-verifier.test.ts — the server-side confirmation verifier
 * (src/engine/repid-update.ts::resolveServerConfirmation), the CWE-345 trust boundary.
 *
 * The verifier takes an ACTOR id and a caller-supplied RECEIPT ID, reads the AUTHORITATIVE row from
 * public.kernel_receipts, and returns a VerifiedConfirmation ONLY when every gate holds — else
 * undefined (fail closed). The caller supplies a lookup key only; the SERVER establishes the verdict
 * and right/wrong. Every gate is shown going BOTH ways (an accept and the matching reject), so no
 * assertion is vacuous.
 *
 * The DB is mocked to serve one controllable `kernel_receipts` row (or to throw). The verifier is the
 * ONLY thing under test here; nothing else in updateRepId runs.
 */

// A single controllable row + a throw switch, read by the mocked db.from('kernel_receipts').
const ctl: { row: Record<string, unknown> | null; throwOnRead: boolean } = { row: null, throwOnRead: false };

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table !== 'kernel_receipts') throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string) => ({
          eq: (_col: string, id: string) => ({
            maybeSingle: async () => {
              if (ctl.throwOnRead) throw new Error('kernel_receipts read failed');
              // Only answer for the id the test stored it under (keyed by receipt_id).
              return { data: ctl.row && ctl.row['receipt_id'] === id ? ctl.row : null, error: null };
            },
          }),
        }),
      };
    },
  },
}));

import { resolveServerConfirmation } from '../src/engine/repid-update';

const ACTOR = 'agent-under-test';

/** A fully-valid, server-authoritative, actor-bound SETTLED row; overrides let each test break one gate. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_id: 'rcpt-1',
    subject_agent_id: ACTOR,
    settled_by: 'holdout',
    verdict_label: 'SETTLED',
    verification_status: 'VERIFIED',
    is_simulated: false,
    ...over,
  };
}

beforeEach(() => {
  ctl.row = null;
  ctl.throwOnRead = false;
});

describe('ACCEPT — a server-authoritative, actor-bound, SETTLED row confirms', () => {
  it('holdout + VERIFIED → { kernel_receipt, holdout, right }', async () => {
    ctl.row = row({ settled_by: 'holdout', verification_status: 'VERIFIED' });
    const vc = await resolveServerConfirmation(ACTOR, 'rcpt-1');
    expect(vc).toEqual({ source: 'kernel_receipt', settledBy: 'holdout', result: 'right' });
  });

  it('known_answer + FAILED → { kernel_receipt, known_answer, wrong } (server establishes WRONG)', async () => {
    ctl.row = row({ settled_by: 'known_answer', verification_status: 'FAILED' });
    const vc = await resolveServerConfirmation(ACTOR, 'rcpt-1');
    expect(vc).toEqual({ source: 'kernel_receipt', settledBy: 'known_answer', result: 'wrong' });
  });

  it('actor binding tolerates surrounding whitespace on both sides (trim-compare)', async () => {
    ctl.row = row({ subject_agent_id: `  ${ACTOR}  ` });
    const vc = await resolveServerConfirmation(`${ACTOR} `, 'rcpt-1');
    expect(vc?.settledBy).toBe('holdout');
  });
});

describe('REJECT — every gate fails closed to undefined', () => {
  it('ACTOR BINDING: a receipt whose subject is ANOTHER agent → undefined', async () => {
    // NON-VACUITY: drop the `subject_agent_id === actorAgentId` check and this returns a confirmation → RED.
    ctl.row = row({ subject_agent_id: 'some-other-agent' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('is_simulated true → undefined (a simulated record never settles a real score)', async () => {
    // NON-VACUITY: accept is_simulated:true and this returns a confirmation → RED.
    ctl.row = row({ is_simulated: true });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('is_simulated null (not explicitly false) → undefined', async () => {
    ctl.row = row({ is_simulated: null });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('verdict_label PROVISIONAL (a vote) → undefined', async () => {
    ctl.row = row({ verdict_label: 'PROVISIONAL' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('verification_status NOT_CHECKED → undefined ("we did not look" is not a verdict)', async () => {
    ctl.row = row({ verification_status: 'NOT_CHECKED' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('verification_status NOT_APPLICABLE → undefined', async () => {
    ctl.row = row({ verification_status: 'NOT_APPLICABLE' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it("settled_by 'person' → undefined (person is NOT a settling source here, per Sean)", async () => {
    ctl.row = row({ settled_by: 'person' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('settled_by null → undefined (a vote that nobody settled)', async () => {
    ctl.row = row({ settled_by: null });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it("settled_by 'counterparty' → undefined (counterparty stays fail-closed on this path)", async () => {
    ctl.row = row({ settled_by: 'counterparty' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('absent row (id not found) → undefined', async () => {
    ctl.row = null;
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-1')).toBeUndefined();
  });

  it('a different receipt id than the one stored → undefined (no fuzzy match)', async () => {
    ctl.row = row({ receipt_id: 'rcpt-1' });
    expect(await resolveServerConfirmation(ACTOR, 'rcpt-OTHER')).toBeUndefined();
  });

  it('empty / whitespace / undefined receiptId → undefined (no pointer, no verification)', async () => {
    ctl.row = row(); // a valid row exists, but no id is asked for
    expect(await resolveServerConfirmation(ACTOR, '')).toBeUndefined();
    expect(await resolveServerConfirmation(ACTOR, '   ')).toBeUndefined();
    expect(await resolveServerConfirmation(ACTOR, undefined)).toBeUndefined();
  });

  it('a thrown DB read → undefined (never throws into the score path)', async () => {
    ctl.row = row();
    ctl.throwOnRead = true;
    await expect(resolveServerConfirmation(ACTOR, 'rcpt-1')).resolves.toBeUndefined();
  });
});
