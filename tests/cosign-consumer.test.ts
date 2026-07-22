/**
 * cosign-consumer.test.ts — fail-closed matrix for the awaiting_cosign consumer.
 *
 * Proves the gate advances ONLY on a disjoint co-sign PASS, and holds (never marks done)
 * on every doubt: missing artifact, missing cosign, unknown producer, self-cosign, non-PASS
 * verdict, malformed record. Also drives one DB-mocked sweep to prove exactly one row (the
 * clean disjoint-PASS) is flipped to `done` and the update is status-guarded.
 */
import {
  evaluateCosign,
  extractCosignRecord,
  toCosignTask,
  cosignConsumerEnabled,
  processAwaitingCosign,
  CosignTask,
} from '../src/services/cosign-consumer';

const base = (over: Partial<CosignTask> = {}): CosignTask => ({
  id: 1,
  producer: 'trinity-torch',
  artifactUrl: 'https://example.com/report.md',
  cosign: { cosigner: 'trinity-mel', verdict: 'pass' },
  ...over,
});

describe('evaluateCosign (fail-closed gate)', () => {
  it('ADVANCES on a disjoint co-signer with an explicit PASS verdict', () => {
    const d = evaluateCosign(base());
    expect(d.advance).toBe(true);
  });

  it.each(['pass', 'PASS', 'verified', 'Approved', 'ok', 'accepted'])(
    'accepts pass-token %s',
    (verdict) => {
      expect(evaluateCosign(base({ cosign: { cosigner: 'trinity-mel', verdict } })).advance).toBe(true);
    }
  );

  it('HOLDS when there is no artifact', () => {
    expect(evaluateCosign(base({ artifactUrl: null })).advance).toBe(false);
  });

  it('HOLDS when there is no co-sign record', () => {
    expect(evaluateCosign(base({ cosign: null })).advance).toBe(false);
  });

  it('HOLDS when the co-signer is missing', () => {
    expect(evaluateCosign(base({ cosign: { cosigner: null, verdict: 'pass' } })).advance).toBe(false);
  });

  it('HOLDS when the producer is unknown (disjointness unprovable)', () => {
    const d = evaluateCosign(base({ producer: null }));
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/disjointness-unprovable/);
  });

  it('HOLDS on a self-cosign (producer === cosigner), case-insensitively', () => {
    const d = evaluateCosign(base({ cosign: { cosigner: 'Trinity-Torch', verdict: 'pass' } }));
    expect(d.advance).toBe(false);
    expect(d.reason).toMatch(/self-cosign-not-disjoint/);
  });

  it.each(['fail', 'reject', 'rejected', 'disputed', '', 'maybe', null])(
    'HOLDS on non-PASS verdict %s',
    (verdict) => {
      expect(evaluateCosign(base({ cosign: { cosigner: 'trinity-mel', verdict } })).advance).toBe(false);
    }
  );

  it('never throws on a garbage task', () => {
    // @ts-expect-error deliberately malformed
    expect(() => evaluateCosign(null)).not.toThrow();
    // @ts-expect-error deliberately malformed
    expect(evaluateCosign(undefined).advance).toBe(false);
  });
});

describe('extractCosignRecord (tolerant, fail-closed on parse trouble)', () => {
  it('reads metadata.cosign { cosigner, verdict }', () => {
    const r = extractCosignRecord({ metadata: { cosign: { cosigner: 'trinity-mel', verdict: 'pass' } } });
    expect(r).toEqual({ cosigner: 'trinity-mel', verdict: 'pass' });
  });

  it('reads metadata.cosign with agent/result aliases', () => {
    const r = extractCosignRecord({ metadata: { cosign: { agent: 'trinity-gcm', result: 'verified' } } });
    expect(r).toEqual({ cosigner: 'trinity-gcm', verdict: 'verified' });
  });

  it('falls back to signatures[] first usable entry', () => {
    const r = extractCosignRecord({ signatures: [{ agent: 'trinity-shofet', vote: 'approved' }] });
    expect(r).toEqual({ cosigner: 'trinity-shofet', verdict: 'approved' });
  });

  it('returns null when no cosign info is present (→ hold)', () => {
    expect(extractCosignRecord({ metadata: {}, signatures: [] })).toBeNull();
    expect(extractCosignRecord({})).toBeNull();
  });

  it('returns null on malformed input rather than throwing', () => {
    expect(extractCosignRecord({ signatures: 'not-an-array' })).toBeNull();
  });
});

describe('toCosignTask (row → decision shape)', () => {
  it('picks producer from claimed_by, then completed_by, then agent_assigned', () => {
    expect(toCosignTask({ id: 5, claimed_by: 'a', completed_by: 'b', agent_assigned: 'c' }).producer).toBe('a');
    expect(toCosignTask({ id: 5, completed_by: 'b', agent_assigned: 'c' }).producer).toBe('b');
    expect(toCosignTask({ id: 5, agent_assigned: 'c' }).producer).toBe('c');
  });

  it('picks artifact from artifact_url then external_artifact_url', () => {
    expect(toCosignTask({ id: 5, external_artifact_url: 'x' }).artifactUrl).toBe('x');
  });
});

describe('cosignConsumerEnabled (default OFF)', () => {
  const orig = process.env.COSIGN_CONSUMER_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.COSIGN_CONSUMER_ENABLED;
    else process.env.COSIGN_CONSUMER_ENABLED = orig;
  });
  it('is false when unset', () => {
    delete process.env.COSIGN_CONSUMER_ENABLED;
    expect(cosignConsumerEnabled()).toBe(false);
  });
  it('is false for anything but literal "true"', () => {
    process.env.COSIGN_CONSUMER_ENABLED = '1';
    expect(cosignConsumerEnabled()).toBe(false);
    process.env.COSIGN_CONSUMER_ENABLED = 'yes';
    expect(cosignConsumerEnabled()).toBe(false);
  });
  it('is true only for "true"', () => {
    process.env.COSIGN_CONSUMER_ENABLED = 'true';
    expect(cosignConsumerEnabled()).toBe(true);
  });
});

// ---- DB-mocked sweep -------------------------------------------------------
describe('processAwaitingCosign (DB-mocked sweep flips only the clean row)', () => {
  it('advances exactly the disjoint-PASS row and holds the rest, guarding on status', async () => {
    const rows = [
      // clean disjoint pass → advance
      {
        id: 101,
        status: 'awaiting_cosign',
        claimed_by: 'trinity-torch',
        artifact_url: 'https://a/1.md',
        metadata: { cosign: { cosigner: 'trinity-mel', verdict: 'pass' } },
      },
      // self-cosign → hold
      {
        id: 102,
        status: 'awaiting_cosign',
        claimed_by: 'trinity-gcm',
        artifact_url: 'https://a/2.md',
        metadata: { cosign: { cosigner: 'trinity-gcm', verdict: 'pass' } },
      },
      // no artifact → hold
      {
        id: 103,
        status: 'awaiting_cosign',
        claimed_by: 'trinity-torch',
        artifact_url: null,
        metadata: { cosign: { cosigner: 'trinity-mel', verdict: 'pass' } },
      },
      // fail verdict → hold
      {
        id: 104,
        status: 'awaiting_cosign',
        claimed_by: 'trinity-torch',
        artifact_url: 'https://a/4.md',
        metadata: { cosign: { cosigner: 'trinity-mel', verdict: 'fail' } },
      },
    ];

    const updateCalls: any[] = [];

    // Chainable mock: .update(payload).eq('id',x).eq('status',s).select('id').maybeSingle()
    const makeUpdateChain = (payload: any) => {
      const captured: any = { payload, eqs: {} };
      const chain: any = {
        eq: (col: string, val: any) => {
          captured.eqs[col] = val;
          return chain;
        },
        select: () => chain,
        maybeSingle: () => {
          updateCalls.push(captured);
          return Promise.resolve({ data: { id: captured.eqs.id }, error: null });
        },
      };
      return chain;
    };

    const db: any = {
      from: (_table: string) => ({
        select: () => ({
          eq: (_c: string, _v: string) => ({
            limit: (_n: number) => Promise.resolve({ data: rows, error: null }),
          }),
        }),
        update: (payload: any) => makeUpdateChain(payload),
      }),
    };

    const r = await processAwaitingCosign(db);

    expect(r.scanned).toBe(4);
    expect(r.advanced).toBe(1);
    expect(r.held).toBe(3);

    // Only task 101 was updated, to 'done', guarded on the awaiting status.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].eqs.id).toBe(101);
    expect(updateCalls[0].eqs.status).toBe('awaiting_cosign');
    expect(updateCalls[0].payload.status).toBe('done');
  });

  it('holds everything on a read error (fail-closed, no throw)', async () => {
    const db: any = {
      from: () => ({
        select: () => ({
          eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
        }),
      }),
    };
    const r = await processAwaitingCosign(db);
    expect(r).toEqual({ scanned: 0, advanced: 0, held: 0 });
  });
});
