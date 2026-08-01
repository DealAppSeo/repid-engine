/**
 * /contracts/:id/fulfill — who may deliver, and double-fulfill prevention.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM double-fulfill.test.ts
 * ----------------------------------------------------------
 * These cases need a caller IDENTITY (`req.agent_id`, attached by
 * authMiddleware). The sibling suite mounts the entire `src/index` app, and
 * mocking the auth middleware there does not take effect — the mock factory
 * never runs, verified by instrumenting it. Rather than keep fighting the app
 * wiring, this mounts the router under test on a bare Express app and injects
 * the identity directly.
 *
 * That is also the better test: the unit under test is the ROUTE's
 * authorization logic, not the application's middleware stack. Isolating it
 * means a failure here points at the route and nowhere else.
 */
import express from 'express';
import request from 'supertest';

let boundAgentId: string | null = null;

const contractRow: Record<string, unknown> = {
  id: 'contract-1',
  status: 'escrowed',
  agreed_price_usdc_raw: 1000,
  provider_agent_id: 'provider-123',
  buyer_agent_id: 'buyer-456',
  service_id: 'service-1',
  result: null,
};
let serviceType = 'a_type_with_no_handler';

jest.mock('../../src/db', () => {
  const chain: any = {
    select: jest.fn(() => chain),
    update: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    maybeSingle: jest.fn(),
    single: jest.fn(),
  };
  return { db: { from: jest.fn((t: string) => { chain.__table = t; return chain; }) } };
});

jest.mock('../../src/services/validation-repid-delta', () => ({
  applyServiceFulfilledDeltas: jest.fn().mockResolvedValue(undefined),
  applyServiceSatisfiedDeltas: jest.fn().mockResolvedValue(undefined),
  applyServiceOutcomeDeltas: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/outcome-notifier', () => ({ registerPendingOutcome: jest.fn().mockResolvedValue(undefined) }));

import { db } from '../../src/db';
import contractsRouter from '../../src/routes/v1/contracts';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stands in for authMiddleware: attaches the caller's bound agent identity.
  app.use((req: any, _res, next) => { if (boundAgentId) req.agent_id = boundAgentId; next(); });
  app.use('/contracts', contractsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  boundAgentId = null;
  contractRow.status = 'escrowed';
  serviceType = 'a_type_with_no_handler';

  const anyDb = db as any;
  const chain = anyDb.from('service_contracts');
  chain.maybeSingle.mockImplementation(() =>
    Promise.resolve({
      data: chain.__table === 'agent_services' ? { service_type: serviceType } : { ...contractRow },
      error: null,
    })
  );
  chain.single.mockImplementation(() =>
    Promise.resolve({ data: { ...contractRow, status: 'fulfilled', result: 'done' }, error: null })
  );
});

describe('who may deliver a contract', () => {
  it('REFUSES an unbound caller — a shared tier key cannot deliver for a provider', async () => {
    boundAgentId = null;
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: 'done' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('unbound_caller');
  });

  it('REFUSES the buyer — only the provider delivers', async () => {
    boundAgentId = 'buyer-456';
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: 'done' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_the_provider');
  });

  it('REFUSES an unrelated third party', async () => {
    boundAgentId = 'someone-else';
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: 'done' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('not_the_provider');
  });

  it('ALLOWS the provider when the service type has no handler', async () => {
    boundAgentId = 'provider-123';
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: 'done' });
    expect(res.status).toBe(200);
  });
});

describe('handler-backed types cannot be self-declared', () => {
  it('REFUSES a direct result for a type that has a registered handler', async () => {
    boundAgentId = 'provider-123';
    serviceType = 'verification'; // has a handler -> must go through the PCP/HAL gate
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: { verdict: 'PASS' } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('handler_delivery_required');
  });

  it('the escape hatch re-opens it, and only for the exact string "true"', async () => {
    boundAgentId = 'provider-123';
    serviceType = 'verification';
    const prev = process.env['ALLOW_DIRECT_FULFILL'];
    try {
      process.env['ALLOW_DIRECT_FULFILL'] = 'TRUE'; // a typo must NOT weaken it
      let res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: { verdict: 'PASS' } });
      expect(res.status).toBe(409);

      process.env['ALLOW_DIRECT_FULFILL'] = 'true';
      res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: { verdict: 'PASS' } });
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env['ALLOW_DIRECT_FULFILL'];
      else process.env['ALLOW_DIRECT_FULFILL'] = prev;
    }
  });
});

describe('double-fulfill prevention still holds', () => {
  it('is idempotent — a second fulfil returns the existing contract without re-applying deltas', async () => {
    boundAgentId = 'provider-123';
    contractRow.status = 'fulfilled';
    const { applyServiceFulfilledDeltas } = jest.requireMock('../../src/services/validation-repid-delta');
    const res = await request(buildApp()).post('/contracts/contract-1/fulfill').send({ result: 'done' });
    expect(res.status).toBe(200);
    expect(applyServiceFulfilledDeltas).not.toHaveBeenCalled();
  });
});
