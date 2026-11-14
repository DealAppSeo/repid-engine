/**
 * Acceptance test for docs/conductor-v1.md: the conductor role runs on principal_grants,
 * not on a new store, and these are the authority claims that doc makes about it.
 *
 * Every case runs against the EXISTING pure decision functions in
 * src/services/principal-grants.ts. Nothing here is new authority logic. If one of these
 * goes red, either the grant rules changed or the doc is wrong; fix the doc in the same
 * change (LESSONS rule 10).
 *
 * Each denial has a control beside it that is allowed, so a check that always says "no"
 * cannot pass (LESSONS rule 5).
 *
 * What the doc proposes but is NOT built is listed as it.todo below, so jest reports it as
 * pending rather than as covered.
 */
import {
  decideMint,
  decideAuthorization,
  decideRevoke,
  type GrantRow,
  type MintRequest,
} from '../src/services/principal-grants';
import type { EffectiveAuthority } from '../src/services/effective-authority';
import type { SignatureCheck } from '../src/services/principal-grant-intent';

const AEFF: EffectiveAuthority = {
  aEff: 1000,
  outcome: 'MEASURED',
  bindingTerm: 'r_route',
  detail: 'fixture',
  rRouteIsLedgerApproximation: true,
};
const SIG: SignatureCheck = { required: false, status: 'NOT_CHECKED', detail: 'fixture' };

const at = (ms: number) => new Date(Date.now() + ms).toISOString();

function grant(o: Partial<GrantRow>): GrantRow {
  return {
    id: 'g',
    grantor_agent_id: 'owner',
    grantee_agent_id: 'pai',
    parent_grant_id: null,
    depth: 0,
    grant_class: 'warm',
    capabilities: ['dispatch:*', 'review:*', 'read:*'],
    caveats: [],
    role: null,
    audit_for: null,
    not_before: at(-1000),
    expires_at: at(3_600_000),
    revoked_at: null,
    revoked_by: null,
    mint_reason: 'fixture',
    created_at: at(-1000),
    idempotency_key: null,
    grantor_signature: null,
    grantor_wallet_address_used: null,
    signature_status: null,
    ...o,
  };
}

// Owner -> PAI (depth 0) -> Conductor (depth 1) -> Worker (depth 2)
const ownerToPai = grant({ id: 'g-pai' });
const paiToConductor = grant({
  id: 'g-cond',
  grantor_agent_id: 'pai',
  grantee_agent_id: 'conductor-a',
  parent_grant_id: 'g-pai',
  depth: 1,
  capabilities: ['dispatch:t12', 'review:pr', 'read:*'],
  expires_at: at(1_800_000),
});
const conductorToWorker = grant({
  id: 'g-work',
  grantor_agent_id: 'conductor-a',
  grantee_agent_id: 'worker-1',
  parent_grant_id: 'g-cond',
  depth: 2,
  capabilities: ['read:*'],
  expires_at: at(900_000),
});

function childOfConductor(o: Partial<MintRequest>): MintRequest {
  return {
    grantorAgentId: 'conductor-a',
    granteeAgentId: 'worker-1',
    grantClass: 'warm',
    capabilities: ['dispatch:t12'],
    caveats: [],
    ttlSeconds: 600,
    parent: paiToConductor,
    ...o,
  };
}

describe('conductor-v1: a conductor cannot widen its own authority', () => {
  it('hands a worker only what the conductor itself holds', () => {
    expect(decideMint(childOfConductor({}), AEFF, SIG).allowed).toBe(true);
    const merge = decideMint(childOfConductor({ capabilities: ['merge:pr'] }), AEFF, SIG);
    expect(merge.allowed).toBe(false);
    expect(merge.allowed === false && merge.reason).toMatch(/not covered by parent/);
  });

  it('cannot grant itself anything', () => {
    const self = decideMint(childOfConductor({ granteeAgentId: 'conductor-a' }), AEFF, SIG);
    expect(self.allowed).toBe(false);
    expect(self.allowed === false && self.reason).toMatch(/self-grants/);
  });

  it("cannot give a worker a grant that outlives the conductor's", () => {
    const long = decideMint(childOfConductor({ ttlSeconds: 7200 }), AEFF, SIG);
    expect(long.allowed).toBe(false);
    expect(long.allowed === false && long.reason).toMatch(/exceed parent/);
  });

  it('is refused a capability its grant does not cover', () => {
    expect(decideAuthorization(paiToConductor, [ownerToPai], 'dispatch:t12', {}).authorized).toBe(true);
    expect(decideAuthorization(paiToConductor, [ownerToPai], 'deploy:railway', {}).authorized).toBe(false);
  });
});

describe('conductor-v1: higher parties override, and nothing lingers', () => {
  it("the Owner revoking the PAI's grant ends the conductor's and the worker's authority", () => {
    const revokedPai = { ...ownerToPai, revoked_at: at(-10) };
    expect(decideAuthorization(conductorToWorker, [paiToConductor, ownerToPai], 'read:x', {}).authorized).toBe(true);
    expect(decideAuthorization(paiToConductor, [revokedPai], 'dispatch:t12', {}).authorized).toBe(false);
    expect(decideAuthorization(conductorToWorker, [paiToConductor, revokedPai], 'read:x', {}).authorized).toBe(false);
  });

  it("a replaced conductor's grant and its workers' grants stop working", () => {
    const revokedCond = { ...paiToConductor, revoked_at: at(-10) };
    expect(decideAuthorization(revokedCond, [ownerToPai], 'dispatch:t12', {}).authorized).toBe(false);
    expect(decideAuthorization(conductorToWorker, [revokedCond, ownerToPai], 'read:x', {}).authorized).toBe(false);
  });

  it('an expired conductor grant is denied, not soft-allowed', () => {
    const expired = { ...paiToConductor, expires_at: at(-1) };
    expect(decideAuthorization(expired, [ownerToPai], 'dispatch:t12', {}).authorized).toBe(false);
  });

  it('only the direct grantor revokes; a worker cannot block it', () => {
    expect(decideRevoke(conductorToWorker, 'conductor-a').allowed).toBe(true);
    expect(decideRevoke(conductorToWorker, 'worker-1').allowed).toBe(false);
    expect(decideRevoke(paiToConductor, 'pai').allowed).toBe(true);
  });

  // A KNOWN GAP the doc states, pinned so it cannot change silently: the Owner cannot revoke a
  // depth-1 conductor grant directly. Today the Owner's lever is revoking the PAI's grant, which
  // ends everything under it (the first test in this block). If this goes red, decideRevoke
  // gained an Owner path: update docs/conductor-v1.md "What is not built".
  it('GAP: the Owner cannot revoke the conductor grant directly, only its ancestor', () => {
    expect(decideRevoke(paiToConductor, 'owner').allowed).toBe(false);
  });
});

describe('conductor-v1: proposed, not built', () => {
  it.todo('one active conductor per scope (no constraint or check exists)');
  it.todo('per-turn coordination snapshot injected into each runtime');
  it.todo('conductor acknowledgement record (needs Owner-approved DDL)');
  it.todo('T12 claim path refuses a task whose required capability the lane lacks');
});
