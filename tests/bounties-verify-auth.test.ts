/**
 * `POST /bounties/:id/verify` — authorization properties.
 *
 * This route pays out real RepID and sits BEFORE the global auth middleware
 * (src/index.ts:376 vs 456), so it is the only thing standing between an
 * anonymous request and an approved payout. These assert the properties, not the
 * implementation, so a future refactor is free to change how it is done and still
 * has to keep it true.
 *
 * Test PROPERTIES adapted from the external report in #445 (thank you
 * @dangquan0765-sketch); the implementation they gate is #446's, which uses the
 * existing scoped-key mechanism rather than the new shared secret that report
 * proposed. The most important test here is the last one, and it exists because
 * the obvious fix was wrong: `admin` is handed to every agent at public
 * registration, so gating on it would have left the route open to anyone willing
 * to send one POST.
 *
 * Lives in tests/ deliberately — jest.config.js roots do not include
 * src/routes/__tests__, so a file there would never run (see CLAUDE.md).
 */

import express from 'express';
import request from 'supertest';
import bountiesRouter from '../src/routes/bounties';
import { validateAgentApiKey } from '../src/auth/api-keys';
import { updateRepId } from '../src/engine/repid-update';
import { BOUNTY_VERIFY_SCOPE } from '../src/services/bounty-authorization';
import { resolveOwner, type OwnerResolution } from '../src/services/agent-owner-resolver';

const fromMock = jest.fn();

jest.mock('../src/db', () => ({ db: { from: (...args: unknown[]) => fromMock(...args) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));
jest.mock('../src/engine/repid-update', () => ({ updateRepId: jest.fn() }));
jest.mock('../src/services/agent-owner-resolver', () => ({
  ...jest.requireActual('../src/services/agent-owner-resolver'),
  resolveOwner: jest.fn(),
}));

const mockValidate = validateAgentApiKey as jest.MockedFunction<typeof validateAgentApiKey>;
const mockUpdateRepId = updateRepId as jest.MockedFunction<typeof updateRepId>;
const mockResolveOwner = resolveOwner as jest.MockedFunction<typeof resolveOwner>;

/** An owner resolution with one wallet claim, or an unresolved one. */
function owned(agentId: string, ownerKey: string | null): OwnerResolution {
  if (ownerKey === null) return { status: 'unknown', agentId, owner: null, claims: [], conflicts: [], reason: 'test', probes: [] };
  const claim = { source: 'binding', assurance: 'onchain', ownerKey, ownerKeyKind: 'wallet', capUsdcPerTx: null, capUsdcTotal: null } as any;
  return { status: 'resolved', agentId, owner: claim, claims: [claim], conflicts: [], reason: null, probes: [] };
}

/** Owners by agent id; an id not listed resolves as unknown. */
function owners(map: Record<string, string>) {
  mockResolveOwner.mockImplementation(async (ref) => owned(ref.id!, map[ref.id!] ?? null));
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(bountiesRouter);
  return app;
}

/** A COMPLETED bounty, plus a record of every update written against it. */
function stubCompletedBounty() {
  const updates: Record<string, unknown>[] = [];
  fromMock.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: {
        id: 'bounty-1',
        status: 'COMPLETED',
        claimant_agent_id: 'claimant-agent',
        bounty_repid: 5000,
      },
      error: null,
    }),
    update: jest.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      // The route guards the move (.eq('status','COMPLETED')) and reads back the moved row.
      const u: any = { eq: jest.fn(() => u), select: jest.fn().mockResolvedValue({ data: [{ id: 'bounty-1' }], error: null }) };
      return u;
    }),
  }));
  return updates;
}

describe('POST /bounties/:id/verify — authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidate.mockResolvedValue(null);
    mockUpdateRepId.mockResolvedValue({ delta: 100 } as never);
    owners({ 'real-verifier': '0xowner-a', 'claimant-agent': '0xowner-b' });
  });

  it('rejects an anonymous caller before reading or mutating any bounty state', async () => {
    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .send({ approved: true, verifierAgentId: 'someone' });

    expect(res.status).toBe(401);
    // The ordering property: auth runs first, so the database is never touched.
    // A check that passes this assertion cannot leak bounty existence either.
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('rejects a valid key that lacks the bounty_verify scope', async () => {
    mockValidate.mockResolvedValue({ agent_id: 'agent-1', scopes: ['score_event'] });

    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('Authorization', 'Bearer ts_live_ordinary')
      .send({ approved: true });

    expect(res.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('records the identity bound to the credential, ignoring the body entirely', async () => {
    const updates = stubCompletedBounty();
    mockValidate.mockResolvedValue({
      agent_id: 'real-verifier',
      scopes: [BOUNTY_VERIFY_SCOPE],
    });

    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_scoped')
      .send({ approved: true, verifierAgentId: 'attacker-supplied' });

    expect(res.status).toBe(200);
    expect(res.body.verifierAgentId).toBe('real-verifier');
    expect(res.body.verifierAgentId).not.toBe('attacker-supplied');
    expect(updates).toEqual([expect.objectContaining({ status: 'VERIFIED' })]);
    expect(mockUpdateRepId).toHaveBeenCalledWith({
      agentId: 'claimant-agent',
      eventType: 'AUDIT_CONTRIBUTION',
    });
  });

  it('gates the rejection path too, and attributes it', async () => {
    const updates = stubCompletedBounty();
    mockValidate.mockResolvedValue({
      agent_id: 'real-verifier',
      scopes: [BOUNTY_VERIFY_SCOPE],
    });

    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_scoped')
      .send({ approved: false });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    // Rejection moves state too, so it must be attributable for the same reason
    // approval is.
    expect(res.body.verifierAgentId).toBe('real-verifier');
    expect(updates).toEqual([{ status: 'CLAIMED', completed_at: null }]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('a revoked bounty_verify key is refused before any read (validate returns null)', async () => {
    mockValidate.mockResolvedValue(null); // revoked_at set: validateAgentApiKey no longer returns it
    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_revoked')
      .send({ approved: true });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe('invalid_credential');
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('an unreachable credential store denies rather than admits', async () => {
    mockValidate.mockRejectedValue(new Error('connection refused'));

    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_scoped')
      .send({ approved: true });

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * `POST /api/v1/agents/register` is public and issues every agent a key with
   * `['score_event','llm_complete','read_card','admin']`. If this route ever
   * accepts `admin`, anyone can obtain that scope in a single unauthenticated
   * call and approve their own payouts — the route would read as protected while
   * being open to the world. This test fails the moment someone "simplifies" the
   * scope check back to `admin`.
   */
  it('does NOT accept the registration-default admin scope', async () => {
    mockValidate.mockResolvedValue({
      agent_id: 'any-registered-agent',
      scopes: ['score_event', 'llm_complete', 'read_card', 'admin'],
    });

    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_from_public_registration')
      .send({ approved: true });

    expect(res.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });
});

describe('POST /bounties/:id/verify — the verifier must be independent of the claimant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRepId.mockResolvedValue({ delta: 100 } as never);
  });

  async function approveAs(verifier: string) {
    const updates = stubCompletedBounty();
    mockValidate.mockResolvedValue({ agent_id: verifier, scopes: [BOUNTY_VERIFY_SCOPE] });
    const res = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'ts_live_scoped')
      .send({ approved: true });
    return { res, updates };
  }

  it('refuses a claimant verifying its own bounty: no state change, no payout', async () => {
    owners({ 'claimant-agent': '0xowner-b' });
    const { res, updates } = await approveAs('claimant-agent');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('self_verification');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('refuses the claimant verifying under an upper-cased copy of its own id', async () => {
    owners({ 'claimant-agent': '0xowner-b', 'CLAIMANT-AGENT': '0xowner-b' });
    const { res, updates } = await approveAs('CLAIMANT-AGENT');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('self_verification');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('refuses a sibling agent under the same owner (case-insensitive wallet)', async () => {
    owners({ 'sibling-verifier': '0xOWNER-B', 'claimant-agent': '0xowner-b' });
    const { res, updates } = await approveAs('sibling-verifier');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('same_owner');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('refuses owners recorded in different namespaces: a builder id and an SBT token can be one human', async () => {
    mockResolveOwner.mockImplementation(async (ref) => {
      const kind = ref.id === 'real-verifier' ? 'builder_id' : 'human_sbt_token';
      const claim = { source: 'binding', assurance: 'onchain', ownerKey: 'k-' + ref.id, ownerKeyKind: kind, capUsdcPerTx: null, capUsdcTotal: null } as any;
      return { status: 'resolved', agentId: ref.id!, owner: claim, claims: [claim], conflicts: [], reason: null, probes: [] };
    });
    const { res, updates } = await approveAs('real-verifier');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('owner_not_established');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('an opaque claim (a KYA custodian tier) is not an owner identity and cannot show a difference', async () => {
    mockResolveOwner.mockImplementation(async (ref) => {
      const claim = { source: 'kya', assurance: 'declared', ownerKey: 'tier-' + ref.id, ownerKeyKind: 'opaque', capUsdcPerTx: null, capUsdcTotal: null } as any;
      return { status: 'resolved', agentId: ref.id!, owner: claim, claims: [claim], conflicts: [], reason: null, probes: [] };
    });
    const { res, updates } = await approveAs('real-verifier');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('owner_not_established');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('refuses when either owner cannot be established: unknown is not independent', async () => {
    owners({ 'real-verifier': '0xowner-a' }); // claimant unresolved
    const { res, updates } = await approveAs('real-verifier');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('owner_not_established');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('a resolver that throws mid-read refuses rather than pays', async () => {
    mockResolveOwner.mockRejectedValue(new Error('db down'));
    const { res, updates } = await approveAs('real-verifier');
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('owner_not_established');
    expect(updates).toEqual([]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('pays once when the owners are positively different', async () => {
    owners({ 'real-verifier': '0xowner-a', 'claimant-agent': '0xowner-b' });
    const { res, updates } = await approveAs('real-verifier');
    expect(res.status).toBe(200);
    expect(updates).toEqual([expect.objectContaining({ status: 'VERIFIED' })]);
    expect(mockUpdateRepId).toHaveBeenCalledTimes(1);
  });
});
