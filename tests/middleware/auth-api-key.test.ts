import { requireApiKey } from '../../src/middleware/auth-api-key';
import { validateAgentApiKey } from '../../src/auth/api-keys';

jest.mock('../../src/auth/api-keys');

describe('Auth Middleware', () => {
  it('rejects missing token', async () => {
    const req: any = { headers: {} };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    await requireApiKey(['scope1'])(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('validates token and scopes', async () => {
    const req: any = { headers: { authorization: 'Bearer ts_live_test' } };
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    (validateAgentApiKey as jest.Mock).mockResolvedValue({ agent_id: 'agent-1', scopes: ['scope1'] });

    await requireApiKey(['scope1'])(req, res, next);
    expect(req.agent_id).toBe('agent-1');
    expect(next).toHaveBeenCalled();
  });
});
