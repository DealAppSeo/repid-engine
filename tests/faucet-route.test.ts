/**
 * faucet-route.test.ts — E2E FAUCET step contract.
 *
 * Verifies:
 *   - GET /faucet/info returns the config-driven shape (chain, staking min, USDC token, faucets).
 *   - GET /faucet/balance gates enough_to_stake on the on-chain ETH balance vs the min.
 *
 * The ethers provider is mocked (partial mock — real utils kept, only JsonRpcProvider +
 * Contract stubbed) so no live RPC is hit. Read-only: no writes, no keys.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

// Controls the mocked native ETH balance (wei) for a given test.
let mockEthWei: bigint = 0n;

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        getBalance: jest.fn().mockImplementation(async () => mockEthWei),
      })),
      Contract: jest.fn().mockImplementation(() => ({
        balanceOf: jest.fn().mockResolvedValue(1_000_000n), // 1 USDC (6 decimals)
        decimals: jest.fn().mockResolvedValue(6n),
      })),
    },
  };
});

import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import faucetRouter from '../src/routes/faucet';
import { STAKING_MIN_ETH } from '../src/config/faucet';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', faucetRouter);
  return app;
}

// A well-formed EVM address for the happy paths.
const ADDR = '0x1111111111111111111111111111111111111111';

describe('E2E faucet routes', () => {
  describe('GET /faucet/info', () => {
    it('returns the config-driven faucet info shape', async () => {
      const res = await request(makeApp()).get('/api/v1/faucet/info');
      expect(res.status).toBe(200);
      expect(res.body.dispenses).toBe(false); // honest: we do not dispense
      expect(res.body.chain_id).toBe(84532); // Base Sepolia
      expect(res.body.staking_min_eth).toBe(STAKING_MIN_ETH);
      expect(typeof res.body.usdc_token_address).toBe('string');
      expect(Array.isArray(res.body.faucets)).toBe(true);
      expect(res.body.faucets.length).toBeGreaterThan(0);
      // Each faucet source has the documented shape.
      for (const f of res.body.faucets) {
        expect(typeof f.name).toBe('string');
        expect(typeof f.url).toBe('string');
        expect(Array.isArray(f.assets)).toBe(true);
      }
    });
  });

  describe('GET /faucet/balance — enough_to_stake gate', () => {
    it('rejects a missing address with 400', async () => {
      const res = await request(makeApp()).get('/api/v1/faucet/balance');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MISSING_ADDRESS');
    });

    it('rejects an invalid address with 400', async () => {
      const res = await request(makeApp()).get('/api/v1/faucet/balance?address=not-an-address');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_ADDRESS');
    });

    it('enough_to_stake=false and a fund hint when balance is below the min', async () => {
      mockEthWei = 0n; // empty wallet
      const res = await request(makeApp()).get(`/api/v1/faucet/balance?address=${ADDR}`);
      expect(res.status).toBe(200);
      expect(res.body.enough_to_stake).toBe(false);
      expect(res.body.next_step).toMatch(/[Ff]und/);
      expect(res.body.eth_balance).toBe('0.0');
    });

    it('enough_to_stake=true when balance meets the min (>= staking_min_eth)', async () => {
      mockEthWei = ethers.parseEther(STAKING_MIN_ETH); // exactly the minimum
      const res = await request(makeApp()).get(`/api/v1/faucet/balance?address=${ADDR}`);
      expect(res.status).toBe(200);
      expect(res.body.enough_to_stake).toBe(true);
    });

    it('reports ready-to-stake once balance covers the suggested gas buffer', async () => {
      mockEthWei = ethers.parseEther('1'); // comfortably above min + gas buffer
      const res = await request(makeApp()).get(`/api/v1/faucet/balance?address=${ADDR}`);
      expect(res.status).toBe(200);
      expect(res.body.enough_to_stake).toBe(true);
      expect(res.body.enough_for_gas).toBe(true);
      expect(res.body.next_step).toBe('Ready to stake.');
      expect(res.body.usdc_balance).toBe('1.0'); // from the mocked ERC-20 read
    });
  });
});
