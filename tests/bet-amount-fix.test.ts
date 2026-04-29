import request from 'supertest';
import express from 'express';
import v1Router from '../src/routes/v1';

jest.mock('../src/services/anonymous-round-runner', () => ({
  runRoundAnonymous: jest.fn(),
}));

import { runRoundAnonymous } from '../src/services/anonymous-round-runner';
import { db } from '../src/db';
import { computeAuthority } from '../src/services/authority-math';

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
  }
}));

const app = express();
app.use(express.json());
app.use('/api/v1', v1Router);

describe('Bet Amount Fix + Authority Scale', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Bug 1: POST /demo/run-round-anonymous reads bet_amount from body', () => {
    it('Sends { bet_amount: "999" } and expects success', async () => {
      (runRoundAnonymous as jest.Mock).mockResolvedValue({
        ok: true,
        round_id: 'test-1',
      });

      const res = await request(app)
        .post('/api/v1/demo/run-round-anonymous')
        .send({ bet_amount: '999', token: 'testToken' });

      expect(res.status).toBe(200);
      expect(runRoundAnonymous).toHaveBeenCalledWith(expect.objectContaining({
        betAmount: 999n
      }));
    });

    it('Sends { bet_amount: "100000000" } and expects BET_EXCEEDS_AUTHORITY', async () => {
      (runRoundAnonymous as jest.Mock).mockImplementation(async (opts) => {
        if (opts.betAmount === 100000000n) {
          const errorJson = JSON.stringify({
            error: 'BET_EXCEEDS_AUTHORITY',
            details: { attempted_bet_raw: 100000000 }
          });
          return { ok: false, error: errorJson };
        }
        return { ok: true };
      });

      const res = await request(app)
        .post('/api/v1/demo/run-round-anonymous')
        .send({ bet_amount: '100000000', token: 'testToken' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BET_EXCEEDS_AUTHORITY');
      expect(res.body.details.attempted_bet_raw).toBe(100000000);
    });
  });

  describe('Bug 2: authority-math produces correct scale', () => {
    it('For stake=100_000_000, R=5500, W=800, C=600, authority is ~50_000_000', () => {
      const res = computeAuthority({
        stakeAmount: 100_000_000n,
        agentRepId: 5500,
        agentWisdom: 800,
        agentCharacter: 600,
        builderRepId: 5500
      });

      const raw = Number(res.authority);
      expect(raw).toBeGreaterThanOrEqual(40_000_000);
      expect(raw).toBeLessThanOrEqual(60_000_000);
      
      // Asserts NOT in [0, 100_000] range
      expect(raw).not.toBeLessThan(100_000);
    });

    it('Uses defaults if fresh demo builder (R=0)', () => {
      const res = computeAuthority({
        stakeAmount: 100_000_000n,
        agentRepId: 0,
        agentWisdom: 0,
        agentCharacter: 0,
        builderRepId: 0
      });

      const raw = Number(res.authority);
      expect(raw).toBeGreaterThanOrEqual(40_000_000);
      expect(raw).toBeLessThanOrEqual(60_000_000);
    });
  });
});
