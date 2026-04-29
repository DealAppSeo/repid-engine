import request from 'supertest';
import express from 'express';
import v1Router from '../src/routes/v1';

jest.mock('../src/services/stake-vault', () => ({
  snapshotAuthority: jest.fn(),
}));

jest.mock('../src/services/anonymous-round-runner', () => ({
  runRoundAnonymous: jest.fn(),
}));

import { snapshotAuthority } from '../src/services/stake-vault';
import { runRoundAnonymous } from '../src/services/anonymous-round-runner';
import { db } from '../src/db';

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  }
}));

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

describe('Guided Tour Endpoints', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/demo/builder/:token/snapshot returns recommended_bet', async () => {
    (db.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'test-uuid', current_repid: 5100, session_token: 'test-token' },
            error: null
          })
        })
      })
    });

    (snapshotAuthority as jest.Mock).mockResolvedValue({
      authority: 10000000n, // $10.00
      basis: { stake: '20000000' }
    });

    const res = await request(app).get('/api/v1/demo/builder/test-uuid/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.authority_raw).toBe(10000000);
    expect(res.body.recommended_bet_raw).toBe(5000000);
    expect(res.body.max_safe_bet_raw).toBe(9500000);
    expect(res.body.recommended_bet_raw).toBeLessThan(res.body.max_safe_bet_raw);
    expect(res.body.max_safe_bet_raw).toBeLessThan(res.body.authority_raw);
  });

  it('GET /api/v1/demo/recommended-bet/:token returns smaller numbers if authority is low', async () => {
    (db.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { id: 'test-uuid' },
            error: null
          })
        })
      })
    });

    (snapshotAuthority as jest.Mock).mockResolvedValue({
      authority: 100n, // very low
      basis: { stake: '100' }
    });

    const res = await request(app).get('/api/v1/demo/recommended-bet/test-uuid');
    expect(res.status).toBe(200);
    expect(res.body.authority_raw).toBe(100);
    expect(res.body.recommended_bet_raw).toBe(50);
    expect(res.body.max_safe_bet_raw).toBe(95);
  });

  it('POST run-round-anonymous returns BET_EXCEEDS_AUTHORITY error code', async () => {
    const errorJson = JSON.stringify({
      error: 'BET_EXCEEDS_AUTHORITY',
      human_message: 'Your agent tried to bet $1.65 but its authority limit is $0.013. The system stopped it.',
      details: { attempted_bet_raw: 1650000 },
      next_step: 'retry_with_recommended'
    });

    (runRoundAnonymous as jest.Mock).mockResolvedValue({
      ok: false,
      error: errorJson
    });

    const res = await request(app).post('/api/v1/demo/run-round-anonymous').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BET_EXCEEDS_AUTHORITY');
    expect(res.body.details.attempted_bet_raw).toBe(1650000);
  });

  it('GET /api/v1/demo/builder/:token/snapshot returns 404 for unknown token', async () => {
    (db.from as jest.Mock).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: null,
            error: null
          })
        })
      })
    });

    const res = await request(app).get('/api/v1/demo/builder/unknown/snapshot');
    expect(res.status).toBe(404);
  });
});
