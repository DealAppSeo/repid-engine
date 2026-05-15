import request from 'supertest';
import express from 'express';
import substanceGateRouter from '../../../src/routes/v1/substance-gate';

// Mock the db and writer functions
jest.mock('../../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnValue({
      insert: jest.fn().mockResolvedValue({ error: null })
    })
  }
}));

jest.mock('../../../src/services/substance-gate-writer', () => ({
  recordGateEvent: jest.fn().mockResolvedValue('fake-uuid'),
  slashRepIDForGateFail: jest.fn().mockResolvedValue(-50),
  appendGateAuditChain: jest.fn().mockResolvedValue(undefined)
}));

const app = express();
app.use(express.json());
app.use(substanceGateRouter);

describe('POST /substance-gate/events', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 on missing fields', async () => {
    const res = await request(app).post('/substance-gate/events').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing required fields');
  });

  it('returns 200 success with shadow_mode', async () => {
    const payload = {
      task: { id: 1, metadata: { test_tier: 'T2a_BETA' } },
      fastResult: { passed: false },
      agentName: 'trinity-w3c',
      contentHash: 'abc',
      shadow_mode: true
    };
    const res = await request(app).post('/substance-gate/events').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gateEventId).toBe('fake-uuid');
    
    const { slashRepIDForGateFail } = require('../../../src/services/substance-gate-writer');
    expect(slashRepIDForGateFail).not.toHaveBeenCalled();
  });
});
