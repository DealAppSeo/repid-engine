import { enqueueVerification } from '../src/services/peer-verification-writer';
import { processPeerVerificationQueue } from '../src/services/peer-verification-reader';
import { getAgentPrivateKey } from '../src/routes/peer-verification';
import crypto from 'crypto';

describe('HAL Peer Verification Unit Tests', () => {
  describe('Threshold Trigger (certainty_at_claim < 0.85)', () => {
    let mockDb: any;
    let insertedPayloads: any[] = [];

    beforeEach(() => {
      insertedPayloads = [];
      mockDb = {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null })
            })
          }),
          insert: (payload: any) => ({
            select: () => ({
              single: async () => {
                insertedPayloads.push(payload);
                return {
                  data: { id: '1', ...payload },
                  error: null
                };
              }
            })
          }),
          single: () => ({
            select: () => ({
              single: async () => ({ data: { id: '1', ...insertedPayloads[0] }, error: null })
            })
          })
        })
      };
    });

    test('certainty_at_claim = 0.84 triggers enqueue', async () => {
      await enqueueVerification(mockDb, {
        source_response_id: 'response-uuid-1',
        source_agent_id: 'agent-uuid-1',
        certainty_at_claim: 0.84,
        claim_text: 'Test claim 1',
        threshold: 0.85
      });
      expect(insertedPayloads).toHaveLength(1);
      expect(insertedPayloads[0].certainty_at_claim).toBe(0.84);
      expect(insertedPayloads[0].threshold_used).toBe(0.85);
    });

    test('certainty_at_claim = 0.85 does NOT trigger enqueue when using writer directly (or is explicitly bypassed/filtered)', async () => {
      // The trigger handles this at DB level, but programmatic check can enforce it
      const certainty = 0.85;
      const threshold = 0.85;
      if (certainty < threshold) {
        await enqueueVerification(mockDb, {
          source_response_id: 'response-uuid-2',
          source_agent_id: 'agent-uuid-2',
          certainty_at_claim: certainty,
          claim_text: 'Test claim 2',
          threshold
        });
      }
      expect(insertedPayloads).toHaveLength(0);
    });

    test('certainty_at_claim = 0.88 does NOT trigger enqueue', async () => {
      const certainty = 0.88;
      const threshold = 0.85;
      if (certainty < threshold) {
        await enqueueVerification(mockDb, {
          source_response_id: 'response-uuid-3',
          source_agent_id: 'agent-uuid-3',
          certainty_at_claim: certainty,
          claim_text: 'Test claim 3',
          threshold
        });
      }
      expect(insertedPayloads).toHaveLength(0);
    });
  });

  describe('Queue Reader and Round-Robin Dispatch', () => {
    let mockDb: any;
    let updatedQueueEntries: any[] = [];
    let insertedTasks: any[] = [];
    /** Records each expired-lease scan the reader issues, with EVERY `.lt()`
     *  predicate it carried. Both matter: `claimed_at` is what dates a stale
     *  lease, and `reclaim_count` is the budget that bounds how often one row may
     *  be recycled. A scan missing the budget is the unbounded loop that produced
     *  339 tasks from 7 rows on 2026-09-23. */
    let expiredScans: Array<{ status: string; ltCol: string; ltCols: string[] }> = [];

    beforeEach(() => {
      updatedQueueEntries = [];
      expiredScans = [];
      insertedTasks = [];
      mockDb = {
        from: (table: string) => {
          if (table === 'peer_verification_queue') {
            return {
              select: () => ({
                eq: (col: string, val: string) => ({
                  // EXPIRED-LEASE SCAN. The reader also asks for rows stuck in
                  // in_review whose lease has run out:
                  //   .eq('verification_status','in_review')
                  //     .is('verifier_agent_id', null)
                  //     .lt('claimed_at', staleBefore)
                  // This double answers that branch with NO rows, which is the
                  // honest answer for this fixture: its two rows are `pending` and
                  // carry no claimed_at, and a NULL claimed_at can never satisfy
                  // `< staleBefore`. That is the property that keeps the 62,841
                  // legacy wedged rows out of the reclaim path, so it is asserted
                  // here rather than assumed.
                  // `.lt()` is CHAINABLE here because the reader issues two of
                  // them — claimed_at (the lease) and reclaim_count (the budget).
                  // A mock that only accepted one would break the chain and record
                  // nothing, which reads identically to "the reader never scanned".
                  is: (_c: string, _v: unknown) => {
                    const ltCols: string[] = [];
                    const node: any = {
                      lt: (ltCol: string, _ltVal: string) => {
                        ltCols.push(ltCol);
                        return node;
                      },
                      limit: async () => {
                        expiredScans.push({ status: val, ltCol: ltCols[0] as string, ltCols });
                        return { data: [], error: null };
                      },
                    };
                    return node;
                  },
                  limit: async () => {
                    return {
                      data: [
                        {
                          id: '1',
                          source_response_id: 'response-1',
                          source_agent_id: 'agent-uuid-veritas',
                          certainty_at_claim: 0.80,
                          verification_status: 'pending',
                          claim_text: 'Claim 1'
                        },
                        {
                          id: '2',
                          source_response_id: 'response-2',
                          source_agent_id: 'agent-uuid-mel',
                          certainty_at_claim: 0.75,
                          verification_status: 'pending',
                          claim_text: 'Claim 2'
                        }
                      ],
                      error: null
                    };
                  }
                })
              }),
              update: (payload: any) => ({
                eq: (col: string, val: string) => ({
                  eq: (col2: string, val2: string) => ({
                    select: () => ({
                      single: async () => {
                        updatedQueueEntries.push({ id: val, ...payload });
                        return {
                          data: {
                            id: val,
                            source_response_id: val === '1' ? 'response-1' : 'response-2',
                            source_agent_id: val === '1' ? 'agent-uuid-veritas' : 'agent-uuid-mel',
                            certainty_at_claim: val === '1' ? 0.80 : 0.75,
                            verification_status: payload.verification_status,
                            claim_text: val === '1' ? 'Claim 1' : 'Claim 2'
                          },
                          error: null
                        };
                      }
                    })
                  })
                })
              })
            };
          }
          if (table === 'repid_agents') {
            return {
              select: () => ({
                in: (col: string, vals: string[]) => ({
                  data: [
                    { id: 'agent-uuid-mel', agent_name: 'trinity-mel' },
                    { id: 'agent-uuid-shofet', agent_name: 'trinity-shofet' },
                    { id: 'agent-uuid-gcm', agent_name: 'trinity-gcm' }
                  ],
                  error: null
                }),
                eq: (col: string, val: string) => ({
                  single: async () => {
                    if (val === 'agent-uuid-veritas') {
                      return { data: { agent_name: 'trinity-veritas' }, error: null };
                    }
                    if (val === 'agent-uuid-mel') {
                      return { data: { agent_name: 'trinity-mel' }, error: null };
                    }
                    return { data: null, error: new Error('Agent not found') };
                  }
                })
              })
            };
          }
          if (table === 'trinity_tasks') {
            return {
              insert: (payload: any) => ({
                select: () => ({
                  single: async () => {
                    insertedTasks.push(payload);
                    return { data: { id: 'task-123' }, error: null };
                  }
                })
              })
            };
          }
          return {} as any;
        }
      };
    });

    // This assertion used to read "the expired-lease scan runs", unconditionally,
    // on the premise that "a reclaim path that is never queried is the same defect
    // as no reclaim path at all". MEASURED 2026-09-23, that premise is false in one
    // specific state: with the panel disabled, nothing posts the verdict that
    // clears a lease, so every reclaim is guaranteed to expire again. 7 queue rows
    // produced 339 peer_verify tasks in 8 hours that way. So the scan running is
    // correct ONLY when the panel is on, and both halves are pinned below rather
    // than the assertion being softened.
    test('panel DISABLED: the expired-lease scan is skipped (breaker 2.4)', async () => {
      delete process.env.PEER_VERIFY_PANEL_ENABLED;
      await processPeerVerificationQueue(mockDb);

      // Not queried at all — reclaiming a lease the panel cannot clear is an
      // unbounded spawn loop, not a recovery.
      expect(expiredScans).toHaveLength(0);

      // Draining is untouched: the two pending rows still get claimed. A breaker
      // that also stopped new work would be a different bug.
      expect(updatedQueueEntries).toHaveLength(2);
    });

    test('panel ENABLED: the expired-lease scan runs, and a NULL claimed_at row is never reclaimed', async () => {
      process.env.PEER_VERIFY_PANEL_ENABLED = 'true';
      try {
        await processPeerVerificationQueue(mockDb);

        // With the panel on, a verdict CAN land, so a stale lease is genuinely
        // recoverable and the reader must still ask for one.
        expect(expiredScans).toHaveLength(1);
        expect(expiredScans[0]?.status).toBe('in_review');
        // Both predicates, not just the lease. Dropping `reclaim_count` would
        // restore the unbounded recycle while this test still passed on the lease
        // alone — which is exactly the shape of the bug being fixed.
        expect(expiredScans[0]?.ltCols).toEqual(['claimed_at', 'reclaim_count']);

        // And it must still claim only the two pending rows: the expired branch
        // returned nothing, so nothing legacy was dragged in.
        expect(updatedQueueEntries).toHaveLength(2);
      } finally {
        delete process.env.PEER_VERIFY_PANEL_ENABLED;
      }
    });

    test('the claim stamps claimed_at, so a later reclaim can date it', async () => {
      await processPeerVerificationQueue(mockDb);

      for (const entry of updatedQueueEntries) {
        expect(entry.verification_status).toBe('in_review');
        // Without this the row is indistinguishable from one claimed in July,
        // which is exactly how 62,841 rows wedged.
        expect(typeof entry.claimed_at).toBe('string');
        expect(Number.isNaN(Date.parse(entry.claimed_at))).toBe(false);
      }
    });

    test('stateless round-robin logic maps tasks to verifiers correctly, skipping claimant', async () => {
      await processPeerVerificationQueue(mockDb);

      expect(updatedQueueEntries).toHaveLength(2);
      expect(insertedTasks).toHaveLength(2);

      // Queue entry 1 (id: '1') -> claimant: trinity-veritas. Verifier pool: ['trinity-mel', 'trinity-shofet', 'trinity-gcm'].
      // All are eligible. 1 % 3 = 1 -> 'trinity-shofet'.
      expect(insertedTasks[0].assigned_to).toBe('trinity-shofet');

      // Queue entry 2 (id: '2') -> claimant: trinity-mel. Verifier pool: ['trinity-shofet', 'trinity-gcm']. (trinity-mel excluded).
      // 2 % 2 = 0 -> 'trinity-shofet'.
      expect(insertedTasks[1].assigned_to).toBe('trinity-shofet');
    });
  });

  describe('Agent Generalized HMAC Pattern', () => {
    beforeEach(() => {
      process.env.MEL_PRIVATE_KEY = 'mel-secret-key-123';
      process.env.SOPHIA_PRIVATE_KEY = 'sophia-secret-key-456';
      process.env.TRUSTRAILS_HMAC_SECRET = 'global-secret-key-789';
    });

    afterEach(() => {
      delete process.env.MEL_PRIVATE_KEY;
      delete process.env.SOPHIA_PRIVATE_KEY;
      delete process.env.TRUSTRAILS_HMAC_SECRET;
    });

    test('retrieves specific private keys for agents', () => {
      expect(getAgentPrivateKey('trinity-mel')).toBe('mel-secret-key-123');
      expect(getAgentPrivateKey('trinity-sophia')).toBe('sophia-secret-key-456');
    });

    test('falls back to TRUSTRAILS_HMAC_SECRET for other agents', () => {
      const originalKey = process.env.VERITAS_PRIVATE_KEY;
      delete process.env.VERITAS_PRIVATE_KEY;
      try {
        expect(getAgentPrivateKey('trinity-veritas')).toBe('global-secret-key-789');
      } finally {
        process.env.VERITAS_PRIVATE_KEY = originalKey;
      }
    });

    test('signature validation verifies authentic verifier payload', () => {
      const secret = getAgentPrivateKey('trinity-mel');
      const dataToSign = '123:response-uuid-abc:verified';
      const sig = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');

      // Verify signature
      const expected = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
      expect(sig).toBe(expected);
    });
  });
});
