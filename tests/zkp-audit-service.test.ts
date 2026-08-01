/**
 * zkp_audit — invariant pins.
 *
 * These tests exist to make the *fraud paths* fail loudly, not to demonstrate a
 * happy path. Every scripted double drives the REAL code path; nothing here
 * simulates a proof or a settlement. The one thing deliberately faked is the
 * WASM verifier and the prover HTTP call, because a unit test must not mint
 * production rows or spend a real proving run — where that matters (i.e. "is
 * this artifact really verifiable?") the answer comes from the live probe
 * recorded in the design, not from this file.
 */
import {
  DEFAULT_ADMISSION_POLICY,
  HONESTY_BLOCK,
  REQUIRED_STATEMENT_KEYS,
  ZKP_AUDIT_SERVICE_TYPE,
  ZkpAuditError,
  assertSubjectDisjoint,
  buildCompleteStatement,
  contractBoundNonce,
  createZkpAuditService,
  deriveTier,
  isRealPlonky3,
  parseProvenThreshold,
  parseZkpAuditPayload,
  proofDigest,
  statementIsComplete,
  verifyDeliverable,
  type AdmissionPolicy,
  type VerifyFn,
  type VerifyResult,
} from '../src/services/zkp-audit-service';
import {
  CHURN_PROOF_EVENT_TYPES,
  evaluateProofEnqueue,
} from '../src/services/proof-enqueue-filter';
import type { ServiceContractRow } from '../src/types';

/* ------------------------------------------------------------------ ids -- */

const SUBJECT = '11111111-1111-1111-1111-111111111111';
const BUYER = '22222222-2222-2222-2222-222222222222';
const PROVIDER = '33333333-3333-3333-3333-333333333333';
const OUTSIDER = '44444444-4444-4444-4444-444444444444';
const CONTRACT = '55555555-5555-5555-5555-555555555555';
const SETTLEMENT = '66666666-6666-6666-6666-666666666666';

const REAL_SCHEME = 'plonky3_range_check';
const PROOF_B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';

/* -------------------------------------------------------- scripted db --- */

interface DbCall {
  table: string;
  op: string;
  payload?: unknown;
}

/**
 * Chainable thenable double. Terminal ops (`maybeSingle`, `single`, awaiting)
 * pop the next scripted result for that table, in order.
 */
function makeDb(script: Record<string, unknown[]>) {
  const queues: Record<string, unknown[]> = Object.fromEntries(
    Object.entries(script).map(([k, v]) => [k, [...v]])
  );
  const calls: DbCall[] = [];

  function pop(table: string): unknown {
    const q = queues[table];
    if (!q || q.length === 0) {
      throw new Error(`unexpected query on table '${table}' (script exhausted)`);
    }
    return q.shift();
  }

  const api = {
    calls,
    from(table: string) {
      const chain: any = {};
      for (const m of ['select', 'eq', 'or', 'in', 'gte', 'lte', 'order', 'limit', 'not']) {
        chain[m] = () => chain;
      }
      chain.insert = (payload: unknown) => {
        calls.push({ table, op: 'insert', payload });
        return chain;
      };
      chain.update = (payload: unknown) => {
        calls.push({ table, op: 'update', payload });
        return chain;
      };
      chain.maybeSingle = () => Promise.resolve(pop(table));
      chain.single = () => Promise.resolve(pop(table));
      chain.then = (onF: any, onR: any) => Promise.resolve(pop(table)).then(onF, onR);
      return chain;
    },
  };
  return api;
}

const ok = <T>(data: T) => ({ data, error: null });
const empty = { data: null, error: null };

/* ---------------------------------------------------------- fixtures ---- */

function contractRow(overrides: Partial<ServiceContractRow> = {}): ServiceContractRow {
  return {
    id: CONTRACT,
    buyer_agent_id: BUYER,
    provider_agent_id: PROVIDER,
    payload: { subject_agent_id: SUBJECT },
    status: 'escrowed',
    service_id: 'svc-1',
    metadata: {},
    ...(overrides as object),
    // x402_payment_id is not on the shared ServiceContractRow type but is on the
    // live row; the service reads it structurally.
  } as ServiceContractRow & Record<string, unknown>;
}

function paidContract(overrides: Record<string, unknown> = {}): ServiceContractRow {
  return {
    ...(contractRow() as object),
    x402_payment_id: SETTLEMENT,
    ...overrides,
  } as ServiceContractRow;
}

const SUBJECT_ROW = {
  id: SUBJECT,
  agent_name: 'trinity-shofet',
  current_repid: 1400,
  tier: 'ESTABLISHED',
  created_at: '2026-01-01T00:00:00.000Z',
  lifecycle_status: 'active',
};

const BUYER_ROW = {
  id: BUYER,
  agent_name: 'trinity-orch',
  current_repid: 1200,
  tier: 'ESTABLISHED',
  created_at: '2026-01-01T00:00:00.000Z',
  lifecycle_status: 'active',
};

/** History proving the subject transacted with someone who is neither counterparty. */
const INDEPENDENT_HISTORY = [{ buyer_agent_id: OUTSIDER, provider_agent_id: SUBJECT }];

function proverResponse(overrides: Record<string, unknown> = {}) {
  return {
    proof_type: REAL_SCHEME,
    proof_bytes: PROOF_B64,
    proof_size_bytes: 10673,
    commitment: '0xdeadbeef',
    public_statement: 'RepID > 999',
    repid_score_actual: 1400,
    score_source: 'server_side_lookup',
    tier: 'ESTABLISHED',
    ...overrides,
  };
}

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: unknown[] = [];
  const impl = (async (_url: any, opts: any) => {
    calls.push({ url: _url, body: JSON.parse(String(opts?.body ?? '{}')) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function fakeVerifier(result: Partial<VerifyResult> = {}): { impl: VerifyFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const impl: VerifyFn = async (proofBytes, statement) => {
    calls.push({ proofBytes, statement });
    return {
      verified: true,
      error: null,
      proof_size_bytes: 10673,
      verifier_version: '0.2.0',
      ...result,
    };
  };
  return { impl, calls };
}

/** The full happy-path db script, in the exact order the service queries. */
function happyScript(overrides: Partial<Record<string, unknown[]>> = {}) {
  return {
    zkp_audit_receipts: [
      empty, // idempotency lookup — no existing receipt
      ok([]), // pair rate-cap lookup
      { data: null, error: null }, // receipt insert
    ],
    x402_settlements: [ok({ is_simulated: false })],
    repid_agents: [ok(SUBJECT_ROW), ok(BUYER_ROW)],
    service_contracts: [ok(INDEPENDENT_HISTORY)],
    repid_zkp_proofs: [ok({ id: 78832 })],
    ...overrides,
  } as Record<string, unknown[]>;
}

function service(opts: {
  db?: ReturnType<typeof makeDb>;
  fetchImpl?: typeof fetch;
  verifyImpl?: VerifyFn;
  proverUrl?: string | null;
  admission?: Partial<AdmissionPolicy>;
}) {
  return createZkpAuditService({
    db: opts.db ?? makeDb(happyScript()),
    proverUrl: opts.proverUrl === undefined ? 'https://prover.example' : opts.proverUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    verifyImpl: opts.verifyImpl ?? fakeVerifier().impl,
    ...(opts.admission ? { admission: opts.admission } : {}),
    log: () => undefined,
    warn: () => undefined,
  });
}

/* ====================================================== pure helpers ==== */

describe('pure helpers', () => {
  it('deriveTier follows the canonical bands and the [10,10000] clamp', () => {
    expect(deriveTier(10)).toBe('PROBATIONARY');
    expect(deriveTier(499)).toBe('PROBATIONARY');
    expect(deriveTier(500)).toBe('EARNING');
    expect(deriveTier(999)).toBe('EARNING');
    expect(deriveTier(1000)).toBe('ESTABLISHED');
    expect(deriveTier(4999)).toBe('ESTABLISHED');
    expect(deriveTier(5000)).toBe('AUTONOMOUS');
    expect(deriveTier(7999)).toBe('AUTONOMOUS');
    expect(deriveTier(8000)).toBe('VETERAN');
    expect(deriveTier(999999)).toBe('VETERAN');
    expect(deriveTier(0)).toBe('PROBATIONARY');
  });

  it('parseProvenThreshold reads the prover’s own public_statement, or null', () => {
    expect(parseProvenThreshold('RepID > 999')).toBe(999);
    expect(parseProvenThreshold('RepID > 0')).toBe(0);
    expect(parseProvenThreshold('no number here')).toBeNull();
    expect(parseProvenThreshold(undefined)).toBeNull();
    expect(parseProvenThreshold(42)).toBeNull();
  });

  it('isRealPlonky3 refuses the sha256 PoC and the sha256-stub scheme', () => {
    expect(isRealPlonky3(REAL_SCHEME, PROOF_B64)).toBe(true);
    expect(isRealPlonky3('sha256_commitment_poc', PROOF_B64)).toBe(false);
    expect(isRealPlonky3('sha256-stub', PROOF_B64)).toBe(false);
    expect(isRealPlonky3(REAL_SCHEME, '')).toBe(false);
    expect(isRealPlonky3(undefined, PROOF_B64)).toBe(false);
  });

  it('statementIsComplete requires all four keys the WASM verifier parses', () => {
    expect(REQUIRED_STATEMENT_KEYS).toEqual(['agent_id', 'tier', 'repid_score', 'threshold']);
    // This is the shape ALL 21,968 existing real rows store — unverifiable as stored.
    expect(statementIsComplete({ threshold: 999, repid_score: 1000 })).toBe(false);
    expect(
      statementIsComplete({ agent_id: SUBJECT, tier: 'ESTABLISHED', repid_score: 1000, threshold: 999 })
    ).toBe(true);
    expect(statementIsComplete(null)).toBe(false);
  });

  it('parseZkpAuditPayload rejects a missing or malformed subject / threshold', () => {
    expect(() => parseZkpAuditPayload({})).toThrow(ZkpAuditError);
    expect(() => parseZkpAuditPayload({ subject_agent_id: '  ' })).toThrow(/subject_agent_id/);
    expect(() =>
      parseZkpAuditPayload({ subject_agent_id: SUBJECT, requested_threshold: 1.5 })
    ).toThrow(/requested_threshold/);
    expect(parseZkpAuditPayload({ subject_agent_id: SUBJECT, requested_threshold: 900 })).toEqual({
      subject_agent_id: SUBJECT,
      requested_threshold: 900,
    });
  });

  it('contractBoundNonce binds the contract id and is still fresh per call', () => {
    const a = contractBoundNonce(CONTRACT);
    const b = contractBoundNonce(CONTRACT);
    expect(a).toMatch(/^0x[0-9a-f]{32}$/);
    expect(a).not.toEqual(b); // freshness, so a replayed contract cannot reuse a commitment
  });
});

/* ============================================== SUBJECT-DISJOINT ======== */

describe('SUBJECT-DISJOINT (no self-validation)', () => {
  it('rejects subject == buyer and subject == provider', () => {
    expect(() =>
      assertSubjectDisjoint({ subjectAgentId: BUYER, buyerAgentId: BUYER, providerAgentId: PROVIDER })
    ).toThrow(/buy an audit of itself/);
    expect(() =>
      assertSubjectDisjoint({
        subjectAgentId: PROVIDER,
        buyerAgentId: BUYER,
        providerAgentId: PROVIDER,
      })
    ).toThrow(/audit itself/);
    expect(() =>
      assertSubjectDisjoint({
        subjectAgentId: SUBJECT,
        buyerAgentId: BUYER,
        providerAgentId: PROVIDER,
      })
    ).not.toThrow();
  });

  it('a subject==provider contract throws before any DB or prover call', async () => {
    const db = makeDb({});
    const f = fakeFetch(proverResponse());
    const svc = service({ db, fetchImpl: f.impl });
    await expect(
      svc.produceAudit(paidContract({ payload: { subject_agent_id: PROVIDER } }))
    ).rejects.toMatchObject({ code: 'SUBJECT_NOT_DISJOINT' });
    expect(f.calls).toHaveLength(0);
    expect(db.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });
});

/* ================================================== happy path ========== */

describe('produceAudit — the only path that returns', () => {
  it('produces a complete, self-verified deliverable and persists proof + receipt', async () => {
    const db = makeDb(happyScript());
    const f = fakeFetch(proverResponse());
    const v = fakeVerifier();
    const out = await service({ db, fetchImpl: f.impl, verifyImpl: v.impl }).produceAudit(
      paidContract()
    );

    expect(out.verdict).toBe('PASS');
    expect(out.service_type).toBe(ZKP_AUDIT_SERVICE_TYPE);
    expect(out.scheme).toBe(REAL_SCHEME);
    expect(out.zkp_proof_id).toBe(78832);
    expect(out.self_verify_ok).toBe(true);
    expect(out.verifier_pkg).toBe('@hyperdag/proof-verifier');
    expect(out.verifier_version).toBe('0.2.0');
    expect(out.proof_sha256).toBe(proofDigest(PROOF_B64));

    // STATEMENT-COMPLETE: the four keys, and nothing that would break the
    // verifier's fixed-struct deserialisation.
    expect(Object.keys(out.statement).sort()).toEqual(
      [...REQUIRED_STATEMENT_KEYS].sort()
    );
    expect(out.statement).toEqual({
      agent_id: SUBJECT,
      tier: 'ESTABLISHED',
      repid_score: 1400,
      threshold: 999,
    });

    // The verifier was run against exactly that statement.
    expect(v.calls).toHaveLength(1);
    expect((v.calls[0] as any).statement).toEqual(out.statement);

    // Honesty block is shipped verbatim so no sales surface can quietly drop it.
    expect(out.honesty).toEqual(HONESTY_BLOCK);
    expect(out.honesty.score_is_public).toBe(true);
    expect(out.honesty.is_score_privacy).toBe(false);
    expect(out.honesty.contract_id_bound_in_stark).toBe(false);

    const proofInsert = db.calls.find(
      (c) => c.table === 'repid_zkp_proofs' && c.op === 'insert'
    );
    expect(proofInsert).toBeDefined();
    const proofPayload = proofInsert!.payload as Record<string, unknown>;

    // IS-REAL-IS-DB-DERIVED: never written app-side (trg_repid_zkp_proofs_maintain_is_real owns it).
    expect(Object.prototype.hasOwnProperty.call(proofPayload, 'is_real')).toBe(false);
    // tier_proven uses the DB's authoritative tier, not the prover's claim.
    expect(proofPayload.tier_proven).toBe('ESTABLISHED');
    expect(proofPayload.proof_type).toBe('POSTCARD');
    expect(proofPayload.scheme).toBe(REAL_SCHEME);
    expect(proofPayload.statement).toEqual(out.statement);

    const receiptInsert = db.calls.find(
      (c) => c.table === 'zkp_audit_receipts' && c.op === 'insert'
    );
    expect(receiptInsert).toBeDefined();
    const receipt = receiptInsert!.payload as Record<string, unknown>;
    expect(receipt.contract_id).toBe(CONTRACT);
    expect(receipt.subject_agent_id).toBe(SUBJECT);
    expect(receipt.buyer_agent_id).toBe(BUYER);
    expect(receipt.provider_agent_id).toBe(PROVIDER);
    expect(receipt.zkp_proof_id).toBe(78832);
    expect(receipt.x402_settlement_id).toBe(SETTLEMENT);
    expect(receipt.self_verify_ok).toBe(true);
  });

  it('DELIVERY-IS-SYNCHRONOUS: never touches repid_proof_queue', async () => {
    const db = makeDb(happyScript());
    await service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract());
    expect(db.calls.some((c) => c.table === 'repid_proof_queue')).toBe(false);
  });
});

/* ========================================== TIER-IS-UNAUTHENTICATED ===== */

describe('TIER-IS-UNAUTHENTICATED', () => {
  it('derives tier from the bound score and ignores the prover’s tier claim', async () => {
    const db = makeDb(happyScript());
    // Prover claims VETERAN for a 1400 score. Measured on the live verifier: a
    // substituted tier still verifies, so the field carries no authority.
    const f = fakeFetch(proverResponse({ tier: 'VETERAN' }));
    const out = await service({ db, fetchImpl: f.impl }).produceAudit(paidContract());
    expect(out.statement.tier).toBe('ESTABLISHED');
    expect(out.tier_derived).toBe('ESTABLISHED');
  });

  it('buildCompleteStatement derives tier purely from repid_score', () => {
    expect(buildCompleteStatement({ subjectAgentId: SUBJECT, repidScore: 8200, threshold: 8000 }))
      .toEqual({ agent_id: SUBJECT, tier: 'VETERAN', repid_score: 8200, threshold: 8000 });
  });
});

/* ============================================== REAL-PROOF-ONLY ========= */

describe('REAL-PROOF-ONLY (the stub is never sellable)', () => {
  it('refuses the sha256 PoC scheme before any DB write', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const f = fakeFetch(proverResponse({ proof_type: 'sha256_commitment_poc' }));
    await expect(
      service({ db, fetchImpl: f.impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'NOT_A_REAL_PROOF' });
    expect(db.calls.some((c) => c.table === 'repid_zkp_proofs' && c.op === 'insert')).toBe(false);
    expect(db.calls.some((c) => c.table === 'zkp_audit_receipts' && c.op === 'insert')).toBe(false);
  });

  it('refuses an empty proof body', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const f = fakeFetch(proverResponse({ proof_bytes: '' }));
    await expect(
      service({ db, fetchImpl: f.impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'NOT_A_REAL_PROOF' });
  });

  it('DEGRADE-CLOSED: an unset prover URL fails hard instead of falling back to the HMAC stub', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    await expect(
      service({ db, proverUrl: null }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'PROVER_UNAVAILABLE' });
  });

  it('a non-2xx prover response is an error, not a fallback', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const f = fakeFetch({ error: 'boom' }, { ok: false, status: 503 });
    await expect(
      service({ db, fetchImpl: f.impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'PROVER_ERROR' });
  });
});

/* ====================================== SELF-VERIFY-OR-FAIL (no dispute) */

describe('SELF-VERIFY-OR-FAIL is fail-closed and NEVER opens a dispute', () => {
  it('a proof that does not verify throws, persists nothing, and files no dispute', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const f = fakeFetch(proverResponse());
    const v = fakeVerifier({ verified: false, error: 'InvalidOpeningArgument(InvalidPowWitness)' });

    await expect(
      service({ db, fetchImpl: f.impl, verifyImpl: v.impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'SELF_VERIFY_FAILED' });

    // The whole point: no artifact is persisted and — critically — nothing is
    // routed to dispute_validation_queue, where a buyer_at_fault ruling would
    // pay the provider +20 and fine the innocent buyer -50.
    expect(db.calls.some((c) => c.table === 'repid_zkp_proofs' && c.op === 'insert')).toBe(false);
    expect(db.calls.some((c) => c.table === 'zkp_audit_receipts' && c.op === 'insert')).toBe(false);
    expect(db.calls.some((c) => c.table === 'dispute_validation_queue')).toBe(false);
  });

  it('a verifier that throws is also fail-closed', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const verifyImpl: VerifyFn = async () => {
      throw new Error('wasm init failed');
    };
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl, verifyImpl }).produceAudit(
        paidContract()
      )
    ).rejects.toMatchObject({ code: 'SELF_VERIFY_FAILED' });
  });

  it('a missing public_statement means the proven threshold is unknown → refuse', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    const f = fakeFetch(proverResponse({ public_statement: undefined }));
    await expect(
      service({ db, fetchImpl: f.impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'STATEMENT_INCOMPLETE' });
  });
});

/* ============================================== NO-SIMULATED-MONEY ====== */

describe('NO-SIMULATED-MONEY', () => {
  it('refuses a contract with no x402_payment_id', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(contractRow())
    ).rejects.toMatchObject({ code: 'PAYMENT_MISSING' });
  });

  it('refuses a simulated settlement', async () => {
    const db = makeDb(
      happyScript({ x402_settlements: [ok({ is_simulated: true })], repid_zkp_proofs: [] })
    );
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'PAYMENT_SIMULATED' });
  });

  it('refuses a contract carrying a simulation flag in metadata', async () => {
    const db = makeDb(happyScript({ repid_zkp_proofs: [] }));
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(
        paidContract({ metadata: { is_simulated: 'TRUE' } })
      )
    ).rejects.toMatchObject({ code: 'PAYMENT_SIMULATED' });
  });
});

/* ================================= cost-based admission (anti-sybil) ==== */

describe('cost-based admission — UUID inequality is not a gate', () => {
  it('defaults keep min_repid_to_purchase-equivalent at 500, not 0', () => {
    expect(DEFAULT_ADMISSION_POLICY.minBuyerRepid).toBe(500);
    expect(DEFAULT_ADMISSION_POLICY.minSubjectRepid).toBe(500);
    expect(DEFAULT_ADMISSION_POLICY.minSubjectIndependentCounterparties).toBeGreaterThan(0);
  });

  it('refuses a three-sybil ring: subject has no INDEPENDENT counterparty', async () => {
    const db = makeDb(
      happyScript({
        // Every completed contract of the subject is with the buyer or provider.
        service_contracts: [ok([{ buyer_agent_id: BUYER, provider_agent_id: SUBJECT }])],
        repid_zkp_proofs: [],
      })
    );
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'ADMISSION_REFUSED' });
  });

  it('refuses a freshly-registered subject', async () => {
    const db = makeDb(
      happyScript({
        repid_agents: [
          ok({ ...SUBJECT_ROW, created_at: new Date().toISOString() }),
          ok(BUYER_ROW),
        ],
        repid_zkp_proofs: [],
      })
    );
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'ADMISSION_REFUSED' });
  });

  it('refuses a low-RepID buyer', async () => {
    const db = makeDb(
      happyScript({
        repid_agents: [ok(SUBJECT_ROW), ok({ ...BUYER_ROW, current_repid: 100 })],
        repid_zkp_proofs: [],
      })
    );
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'ADMISSION_REFUSED' });
  });

  it('caps how fast one (buyer, provider) pair can mint certificates', async () => {
    const db = makeDb(
      happyScript({
        zkp_audit_receipts: [empty, ok([{ id: 1 }, { id: 2 }, { id: 3 }])],
        repid_zkp_proofs: [],
      })
    );
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'ADMISSION_REFUSED' });
  });
});

/* ================================================== idempotency ========= */

describe('IDEMPOTENT', () => {
  it('a retried fulfil reuses the existing proof and never pays for a second proving run', async () => {
    const db = makeDb({
      zkp_audit_receipts: [
        ok({
          contract_id: CONTRACT,
          subject_agent_id: SUBJECT,
          zkp_proof_id: 78832,
          statement: { agent_id: SUBJECT, tier: 'ESTABLISHED', repid_score: 1400, threshold: 999 },
          proof_sha256: proofDigest(PROOF_B64),
          proof_size_bytes: 10673,
          verifier_version: '0.2.0',
          tier_derived: 'ESTABLISHED',
          created_at: '2026-07-31T15:56:08.486Z',
        }),
      ],
      repid_zkp_proofs: [
        ok({ proof_bytes: PROOF_B64, scheme: REAL_SCHEME, zk_commitment: '0xabc' }),
      ],
    });
    const f = fakeFetch(proverResponse());
    const out = await service({ db, fetchImpl: f.impl }).produceAudit(paidContract());

    expect(f.calls).toHaveLength(0); // no prover call
    expect(out.zkp_proof_id).toBe(78832);
    expect(out.proof_bytes).toBe(PROOF_B64);
    expect(db.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('a receipts-table read error fails closed rather than minting a second proof', async () => {
    const db = makeDb({
      zkp_audit_receipts: [{ data: null, error: { message: 'connection reset' } }],
    });
    await expect(
      service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(paidContract())
    ).rejects.toMatchObject({ code: 'PERSIST_FAILED' });
  });
});

/* ============================================ THRESHOLD-IS-PROVER-BOUND = */

describe('THRESHOLD-IS-PROVER-BOUND', () => {
  it('reports a requested-vs-proven mismatch by COMPARISON, never by re-verifying', async () => {
    const db = makeDb(happyScript());
    const f = fakeFetch(proverResponse({ public_statement: 'RepID > 999' }));
    const v = fakeVerifier();
    const out = await service({ db, fetchImpl: f.impl, verifyImpl: v.impl }).produceAudit(
      paidContract({ payload: { subject_agent_id: SUBJECT, requested_threshold: 1200 } })
    );

    expect(out.proven_threshold).toBe(999);
    expect(out.requested_threshold).toBe(1200);
    expect(out.requested_threshold_honored).toBe(false); // 999 < 1200
    // Exactly one verify call, at the PROVEN threshold.
    expect(v.calls).toHaveLength(1);
    expect((v.calls[0] as any).statement.threshold).toBe(999);
    expect(out.statement.threshold).toBe(999);
  });

  it('marks the request honored when the proven threshold meets it', async () => {
    const db = makeDb(happyScript());
    const out = await service({ db, fetchImpl: fakeFetch(proverResponse()).impl }).produceAudit(
      paidContract({ payload: { subject_agent_id: SUBJECT, requested_threshold: 500 } })
    );
    expect(out.requested_threshold_honored).toBe(true);
  });

  it('forwards the requested threshold to the prover but never assumes it was used', async () => {
    const db = makeDb(happyScript());
    const f = fakeFetch(proverResponse());
    await service({ db, fetchImpl: f.impl }).produceAudit(
      paidContract({ payload: { subject_agent_id: SUBJECT, requested_threshold: 700 } })
    );
    expect((f.calls[0] as any).body.threshold).toBe(700);
    expect((f.calls[0] as any).body.agent_id).toBe(SUBJECT);
    expect((f.calls[0] as any).body.metadata.contract_id).toBe(CONTRACT);
  });
});

/* ================================== independent re-verification ========= */

describe('verifyDeliverable — the dispute-panel / buyer entry point', () => {
  const goodResult = {
    statement: { agent_id: SUBJECT, tier: 'ESTABLISHED', repid_score: 1400, threshold: 999 },
    proof_bytes: PROOF_B64,
    scheme: REAL_SCHEME,
    proof_sha256: proofDigest(PROOF_B64),
  };

  it('accepts a genuine deliverable', async () => {
    const v = fakeVerifier();
    const r = await verifyDeliverable(goodResult, { verifyImpl: v.impl });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.verifier_version).toBe('0.2.0');
  });

  it('rejects the fulfil-bypass forgery (garbage bytes under a PASS verdict)', async () => {
    const v = fakeVerifier({ verified: false, error: 'InvalidOpeningArgument(InvalidPowWitness)' });
    const r = await verifyDeliverable(
      { ...goodResult, proof_bytes: 'bm90LWEtcHJvb2Y=', proof_sha256: proofDigest('bm90LWEtcHJvb2Y=') },
      { verifyImpl: v.impl }
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('WASM_VERIFY_FAILED');
  });

  it('rejects a legacy-shaped statement without ever calling the verifier', async () => {
    const v = fakeVerifier();
    const r = await verifyDeliverable(
      { ...goodResult, statement: { threshold: 999, repid_score: 1400 } },
      { verifyImpl: v.impl }
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('STATEMENT_INCOMPLETE');
    expect(v.calls).toHaveLength(0);
  });

  it('rejects a proof about a different, higher-reputation agent', async () => {
    const v = fakeVerifier();
    const r = await verifyDeliverable(goodResult, {
      verifyImpl: v.impl,
      expectedSubjectAgentId: OUTSIDER,
    });
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('SUBJECT_MISMATCH');
  });

  it('detects a tampered proof body via the receipt digest', async () => {
    const v = fakeVerifier();
    const r = await verifyDeliverable(
      { ...goodResult, proof_bytes: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo9' },
      { verifyImpl: v.impl }
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('PROOF_DIGEST_MISMATCH');
  });

  it('rejects a stub scheme outright', async () => {
    const v = fakeVerifier();
    const r = await verifyDeliverable(
      { ...goodResult, scheme: 'sha256_commitment_poc' },
      { verifyImpl: v.impl }
    );
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('NOT_A_REAL_PROOF');
  });
});

/* =========================================== CHURN-FILTER-SURVIVAL ====== */

describe('CHURN-FILTER-SURVIVAL', () => {
  it('a paid contract’s SERVICE_FULFILLED event is never classified as churn', () => {
    expect(CHURN_PROOF_EVENT_TYPES.has('SERVICE_FULFILLED')).toBe(false);
    expect(CHURN_PROOF_EVENT_TYPES.has('HAL_SCORE_EVENT')).toBe(true);
    for (const mode of ['off', 'shadow', 'enforce'] as const) {
      expect(evaluateProofEnqueue('SERVICE_FULFILLED', mode).skip).toBe(false);
      expect(evaluateProofEnqueue('SERVICE_FULFILLED', mode).churn).toBe(false);
    }
    expect(evaluateProofEnqueue('HAL_SCORE_EVENT', 'enforce').skip).toBe(true);
  });
});

/* ============================================== handler adapter ========= */

jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));

// eslint-disable-next-line import/first
import { ZkpAuditServiceHandler, resolveProverUrl } from '../src/services/handlers/zkp-audit-handler';

describe('ZkpAuditServiceHandler', () => {
  it('claims the reused zkp_attestation marketplace category', () => {
    const h = new ZkpAuditServiceHandler({ service: { produceAudit: async () => ({} as any) } });
    expect((h as unknown as { serviceType: string }).serviceType).toBe('zkp_attestation');
    expect(ZKP_AUDIT_SERVICE_TYPE).toBe('zkp_attestation');
  });

  it('re-throws instead of returning a FAIL verdict, so nothing enters the dispute economy', async () => {
    const h = new ZkpAuditServiceHandler({
      service: {
        produceAudit: async () => {
          throw new ZkpAuditError('SELF_VERIFY_FAILED', 'proof did not verify');
        },
      },
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      (h as unknown as { fulfill: (c: ServiceContractRow) => Promise<unknown> }).fulfill(
        paidContract()
      )
    ).rejects.toMatchObject({ code: 'SELF_VERIFY_FAILED' });
    spy.mockRestore();
  });

  it('resolveProverUrl returns null (not a stub URL) when unset', () => {
    expect(resolveProverUrl({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProverUrl({ ZKP_SERVICE_URL: '  ' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveProverUrl({ ZKP_SERVICE_URL: 'https://p.example' } as NodeJS.ProcessEnv)).toBe(
      'https://p.example'
    );
  });
});
