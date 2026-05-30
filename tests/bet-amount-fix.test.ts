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
    maybeSingle: jest.fn().mockResolvedValue({ data: null }),
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
    it('For stake=100_000_000, R=5500, W=800, C=600, authority is ~1_000_000_000', () => {
      const res = computeAuthority({
        stakeAmount: 100_000_000n,
        agentRepId: 5500,
        agentWisdom: 800,
        agentCharacter: 600,
        builderRepId: 5500
      });

      const raw = Number(res.authority);
      expect(raw).toBe(1_000_000_000);
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
      expect(raw).toBe(1_000_000_000);
    });

    it('Asserts D-053 test vectors for real USD square root synthesis', () => {
      // 1. $6,400 stake -> 8000 authority cap
      const v1 = computeAuthority({
        stakeAmount: 6_400_000_000n, // $6400
        agentRepId: 9000,            // R > 8000
        agentWisdom: 1000,
        agentCharacter: 1000,
        builderRepId: 9000
      });
      expect(v1.authority).toBe(8_000_000_000n);

      // 2. $2,500 stake -> 5000 authority cap
      const v2 = computeAuthority({
        stakeAmount: 2_500_000_000n, // $2500
        agentRepId: 9000,
        agentWisdom: 1000,
        agentCharacter: 1000,
        builderRepId: 9000
      });
      expect(v2.authority).toBe(5_000_000_000n);

      // 3. $100 stake -> 1000 authority cap
      const v3 = computeAuthority({
        stakeAmount: 100_000_000n, // $100
        agentRepId: 9000,
        agentWisdom: 1000,
        agentCharacter: 1000,
        builderRepId: 9000
      });
      expect(v3.authority).toBe(1_000_000_000n);

      // 4. $25 stake -> 500 authority cap
      const v4 = computeAuthority({
        stakeAmount: 25_000_000n, // $25
        agentRepId: 9000,
        agentWisdom: 1000,
        agentCharacter: 1000,
        builderRepId: 9000
      });
      expect(v4.authority).toBe(500_000_000n);

      // 5. Whale at $50k with R=300 -> capped at ~300
      const v5 = computeAuthority({
        stakeAmount: 50_000_000_000n, // $50,000
        agentRepId: 300,
        agentWisdom: 1000,
        agentCharacter: 1000,
        builderRepId: 9000
      });
      expect(v5.authority).toBe(300_000_000n); // 300 authority
    });
  });
});
