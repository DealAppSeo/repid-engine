import express from 'express';
import request from 'supertest';
import bountiesRouter from '../src/routes/bounties';
import { validateAgentApiKey } from '../src/auth/api-keys';
import { updateRepId } from '../src/engine/repid-update';

const fromMock = jest.fn();

jest.mock('../src/db', () => ({
  db: { from: (...args: unknown[]) => fromMock(...args) },
}));
jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn(),
}));
jest.mock('../src/engine/repid-update', () => ({ updateRepId: jest.fn() }));

const mockValidateKey = validateAgentApiKey as jest.MockedFunction<typeof validateAgentApiKey>;
const mockUpdateRepId = updateRepId as jest.MockedFunction<typeof updateRepId>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(bountiesRouter);
  return app;
}

function mockCompletedBounty() {
  const bounty = {
    id: 'bounty-1',
    status: 'COMPLETED',
    claimant_agent_id: 'claimant-1',
    bounty_repid: 5000,
  };
  const updates: Record<string, unknown>[] = [];

  fromMock.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: bounty, error: null }),
    update: jest.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return { eq: jest.fn().mockResolvedValue({ error: null }) };
    }),
  }));

  return updates;
}

describe('POST /bounties/:id/verify authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CONTROLLER_MASTER_KEY;
    mockValidateKey.mockResolvedValue(null);
    mockUpdateRepId.mockResolvedValue({ delta: 100 } as never);
  });

  it('rejects an anonymous verification before reading or mutating bounty state', async () => {
    const response = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .send({ approved: true, verifierAgentId: 'sean' });

    expect(response.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('rejects a valid agent key without admin scope', async () => {
    mockValidateKey.mockResolvedValue({ agent_id: 'agent-1', scopes: ['bounties:read'] });

    const response = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('Authorization', 'Bearer ordinary-agent-key')
      .send({ approved: true });

    expect(response.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('accepts an admin-scoped key and uses its bound identity, not the request body', async () => {
    const updates = mockCompletedBounty();
    mockValidateKey.mockResolvedValue({ agent_id: 'trusted-admin', scopes: ['admin'] });

    const response = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'admin-key')
      .send({ approved: true, verifierAgentId: 'attacker-controlled' });

    expect(response.status).toBe(200);
    expect(response.body.verifierAgentId).toBe('trusted-admin');
    expect(updates).toEqual([expect.objectContaining({ status: 'VERIFIED' })]);
    expect(mockUpdateRepId).toHaveBeenCalledTimes(1);
    expect(mockUpdateRepId).toHaveBeenCalledWith({
      agentId: 'claimant-1',
      eventType: 'AUDIT_CONTRIBUTION',
    });
  });

  it('accepts the controller master key and protects the rejection path too', async () => {
    const updates = mockCompletedBounty();
    process.env.CONTROLLER_MASTER_KEY = 'controller-master-key';

    const response = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('Authorization', 'Bearer controller-master-key')
      .send({ approved: false });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('REJECTED');
    expect(updates).toEqual([{ status: 'CLAIMED', completed_at: null }]);
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });

  it('does not treat a shared environment API key as a bounty verifier', async () => {
    const response = await request(buildApp())
      .post('/bounties/bounty-1/verify')
      .set('x-api-key', 'shared-env-key')
      .send({ approved: true });

    expect(response.status).toBe(403);
    expect(fromMock).not.toHaveBeenCalled();
    expect(mockUpdateRepId).not.toHaveBeenCalled();
  });
});
