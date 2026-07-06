/**
 * stake-onchain — on-chain RepIDStaking path tests (2026-07-06).
 *
 * Covers:
 *   1. GET /api/v1/stake/onchain/info returns the contract-info shape.
 *   2. POST /api/v1/stake/onchain/verify with an UNverified tx → 400, and the
 *      STAKE RepID delta (updateRepId) is NEVER called (no tx → no +5).
 *   3. POST verify with a VERIFIED tx → grants the delta, carrying tx_hash.
 *   4. The delta-gate in the engine itself: STAKE without stakeProof → 0.
 *
 * The stake-onchain service and updateRepId are mocked at the module boundary
 * so no live RPC / DB is required.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../src/services/stake-onchain', () => ({
  getStakingContractInfo: jest.fn(),
  verifyStakeOnChain: jest.fn(),
}));

jest.mock('../src/engine/repid-update', () => ({
  updateRepId: jest.fn(),
}));

// stakeRouter also imports these; give them inert mocks so import succeeds.
jest.mock('../src/db', () => ({ db: { from: jest.fn() } }));
jest.mock('../src/repid-staking/repid-fraction', () => ({ fractionForRepID: () => 0.1 }));

import stakeRouter from '../src/routes/stake';
import { getStakingContractInfo, verifyStakeOnChain } from '../src/services/stake-onchain';
import { updateRepId } from '../src/engine/repid-update';

const app = express();
app.use(express.json());
app.use('/api/v1', stakeRouter);

const TX = '0x' + 'a'.repeat(64);

afterEach(() => jest.clearAllMocks());

describe('GET /api/v1/stake/onchain/info', () => {
  it('returns the contract-info shape (address, min_stake_wei, chain_id 84532, network)', async () => {
    (getStakingContractInfo as jest.Mock).mockResolvedValue({
      contractAddress: '0x00000000000000000000000000000000DeaDBeef',
      minStakeWei: '100000000000000', // 0.0001 ETH
      chainId: 84532,
      network: 'base-sepolia',
    });

    const res = await request(app).get('/api/v1/stake/onchain/info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      contract_address: '0x00000000000000000000000000000000DeaDBeef',
      min_stake_wei: '100000000000000',
      chain_id: 84532,
      network: 'base-sepolia',
      deployed: true,
    });
  });

  it('reports deployed=false + empty address when the contract is undeployed', async () => {
    (getStakingContractInfo as jest.Mock).mockResolvedValue({
      contractAddress: '',
      minStakeWei: '100000000000000',
      chainId: 84532,
      network: 'base-sepolia',
    });
    const res = await request(app).get('/api/v1/stake/onchain/info');
    expect(res.status).toBe(200);
    expect(res.body.deployed).toBe(false);
    expect(res.body.contract_address).toBe('');
  });
});

describe('POST /api/v1/stake/onchain/verify — verify GATES the +5', () => {
  it('400 on missing fields and never scores', async () => {
    const res = await request(app).post('/api/v1/stake/onchain/verify').send({ agent_id: 'a1' });
    expect(res.status).toBe(400);
    expect(updateRepId).not.toHaveBeenCalled();
  });

  it('UNverified tx → 400, and NO STAKE delta is applied (no verified stake, no +5)', async () => {
    (verifyStakeOnChain as jest.Mock).mockResolvedValue({
      verified: false,
      reason: 'no Staked event for this agent in tx',
      txHash: TX,
      basescanUrl: `https://sepolia.basescan.org/tx/${TX}`,
    });

    const res = await request(app)
      .post('/api/v1/stake/onchain/verify')
      .send({ agent_id: 'agent-uuid', tx_hash: TX });

    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
    // The core guarantee: an unverified stake never touches RepID.
    expect(updateRepId).not.toHaveBeenCalled();
  });

  it('VERIFIED tx → grants the delta and passes tx_hash as provenance', async () => {
    (verifyStakeOnChain as jest.Mock).mockResolvedValue({
      verified: true,
      reason: null,
      txHash: TX,
      stakeId: '1',
      onChainAgentId: '42',
      amountWei: '100000000000000',
      decisionHash: '0',
      contractAddress: '0x00000000000000000000000000000000DeaDBeef',
      blockNumber: 123,
      basescanUrl: `https://sepolia.basescan.org/tx/${TX}`,
    });
    (updateRepId as jest.Mock).mockResolvedValue({ delta: 5, repIdAfter: 1005, tier: 'ESTABLISHED' });

    const res = await request(app)
      .post('/api/v1/stake/onchain/verify')
      .send({ agent_id: 'agent-uuid', tx_hash: TX });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(res.body.repid_delta_applied).toBe(5);
    expect(updateRepId).toHaveBeenCalledTimes(1);
    const call = (updateRepId as jest.Mock).mock.calls[0][0];
    expect(call.eventType).toBe('STAKE');
    expect(call.stakeProof.txHash).toBe(TX);
  });
});
