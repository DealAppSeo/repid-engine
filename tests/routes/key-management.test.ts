import request from 'supertest';
import express from 'express';
import keyManagementRouter from '../../src/routes/key-management';
import { validateAgentApiKey } from '../../src/auth/api-keys';

jest.mock('../../src/auth/api-keys');

const app = express();
app.use(express.json());
app.use('/agents', keyManagementRouter);

describe('Key Management Endpoints', () => {
  it('prevents access without valid key', async () => {
    const res = await request(app).get('/agents/agent-1/keys');
    expect(res.status).toBe(401);
  });
});
