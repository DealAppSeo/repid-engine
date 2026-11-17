/**
 * POST /api/v1/stake/deposit/gasless: the route's catch-all answers a fixed message. It used to return
 * the thrown error's text, and ethers puts the RPC URL, and any key in it, in its messages (review of
 * #1558). The service is mocked to throw such an error; nothing is read from a chain or a database.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../src/db', () => ({
  db: { from: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue({ data: null }) },
}));
jest.mock('../src/services/gasless-deposit', () => ({
  gaslessDeposit: jest.fn(async () => { throw new Error('missing response https://rpc.example.invalid/v2/NOT-A-REAL-KEY-123'); }),
  defaultGaslessDeps: jest.fn(() => ({})),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const v1Router = require('../src/routes/v1').default;

test('an internal throw answers 500 with a fixed message, never the error text', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', v1Router);
    const res = await request(app).post('/api/v1/stake/deposit/gasless').send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, sent: 'unknown', code: 'internal' });
    expect(JSON.stringify(res.body)).not.toMatch(/NOT-A-REAL-KEY-123|rpc\.example|https?:\/\//);
  } finally {
    spy.mockRestore();
  }
});
