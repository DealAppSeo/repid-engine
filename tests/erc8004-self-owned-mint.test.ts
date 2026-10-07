/**
 * Each agent registers its OWN ERC-8004 identity (Sean, 2026-10-06: "each agent has their own
 * id and Rep").
 *
 * WHAT WAS WRONG. `Erc8004Minter.mint` signed `register(string)` with the minter key, and the
 * registry makes `msg.sender` both the token's owner and its `agentWallet`. So the minter owned
 * every identity it minted and was every agent's official acting address. Measured on-chain
 * 2026-10-06 (ownerOf + getAgentWallet): 8 of the 12 house agents sit on the deployer address
 * and 3 more on one other address.
 *
 * NOW. The agent's own custodied wallet signs `register`, so owner = agentWallet = the agent.
 * The minter only pays gas, and only on Base Sepolia, and never more than MAX_GAS_TOPUP_WEI.
 * Every case in which the identity would not be the agent's alone is refused before anything
 * is sent. These tests use a fake chain and a fake database; nothing touches a network.
 */
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { Erc8004Minter, GAS_TOPUP_CHAIN_ID, MAX_GAS_TOPUP_WEI } from '../src/services/erc8004-minter';
import { createAgentsOnchainRouter } from '../src/routes/agents-onchain';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const MINTER_KEY = '0x' + '11'.repeat(32);
const AGENT_KEY = '0x' + '22'.repeat(32);
const MINTER = new ethers.Wallet(MINTER_KEY).address;
const AGENT = new ethers.Wallet(AGENT_KEY).address;
const TOKEN_ID = 6789n;
const GAS = 180_000n;
const PRICE = 1_000_000n; // 0.001 gwei
const NEED = GAS * PRICE * 2n;

interface World {
  balance: bigint;
  sent: Array<{ to: string; value: bigint }>;
  registeredBy: string[];
  updates: Array<Record<string, unknown>>;
  ownerOf: () => Promise<string>;
  agentWallet: () => Promise<string>;
}

function fakeSupabase(world: World, row: Record<string, unknown>) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          world.updates.push(payload);
          return { error: null };
        },
      }),
    }),
  } as any;
}

function build(opts: {
  agentKey?: string | null;
  walletAddress?: string | null;
  balance?: bigint;
  chainId?: number;
  price?: bigint;
  ownerOf?: () => Promise<string>;
  agentWallet?: () => Promise<string>;
}) {
  const world: World = {
    balance: opts.balance ?? 0n,
    sent: [],
    registeredBy: [],
    updates: [],
    ownerOf: opts.ownerOf ?? (async () => AGENT),
    agentWallet: opts.agentWallet ?? (async () => AGENT),
  };
  const minter = new Erc8004Minter({
    rpcUrl: 'http://127.0.0.1:1',
    contractAddress: REGISTRY,
    minterPrivateKey: MINTER_KEY,
    chainId: opts.chainId ?? GAS_TOPUP_CHAIN_ID,
    supabase: fakeSupabase(world, { agent_name: 'atlas', erc8004_token_id: null, mint_tx_hash: null, wallet_address: opts.walletAddress === undefined ? AGENT : opts.walletAddress }),
    loadAgentKey: async () => (opts.agentKey === undefined ? AGENT_KEY : opts.agentKey),
  });
  const price = opts.price ?? PRICE;
  const provider = {
    getFeeData: async () => ({ maxFeePerGas: price, gasPrice: price }),
    getBalance: async () => world.balance,
  };
  const registeredTopic = ethers.id('Registered(uint256,string,address)');
  const registryFor = (signer: { address: string }) => {
    const register = Object.assign(
      async () => {
        world.registeredBy.push(signer.address);
        return {
          hash: '0x' + 'ab'.repeat(32),
          wait: async () => ({ status: 1, blockNumber: 123, gasUsed: GAS, logs: [{ topics: [registeredTopic, ethers.toBeHex(TOKEN_ID, 32)] }] }),
        };
      },
      { estimateGas: async () => GAS },
    );
    return { 'register(string)': register };
  };
  (minter as any).provider = provider;
  (minter as any).signer = {
    address: MINTER,
    sendTransaction: async (tx: { to: string; value: bigint }) => {
      world.sent.push(tx);
      world.balance += tx.value;
      return { hash: '0x' + 'cd'.repeat(32), wait: async () => ({ status: 1 }) };
    },
  };
  (minter as any).contract = {
    connect: (signer: { address: string }) => registryFor(signer),
    ownerOf: () => world.ownerOf(),
    getAgentWallet: () => world.agentWallet(),
  };
  return { minter, world };
}

describe('the agent registers its own identity', () => {
  it('the agent wallet sends register, owns the token, and the minter only tops up the gas', async () => {
    const { minter, world } = build({ balance: 0n });
    const result = await minter.mint({ agentId: 'agent-1' });

    expect(world.registeredBy).toEqual([AGENT]);
    expect(world.sent).toEqual([{ to: AGENT, value: NEED }]);
    expect(result).toMatchObject({ ownerAddress: AGENT, gasFunderAddress: MINTER, tokenId: TOKEN_ID.toString(), selfOwned: 'VERIFIED' });
    expect(result.gasTopUpTxHash).toMatch(/^0x(cd){32}$/);
    expect(world.updates).toHaveLength(1);
    expect(world.updates[0]).toMatchObject({ conservator_address: AGENT, erc8004_address: REGISTRY, erc8004_token_id: TOKEN_ID.toString() });
    expect(String(world.updates[0]!.conservator_address).toLowerCase()).not.toBe(MINTER.toLowerCase());
  });

  it('sends no top-up when the agent wallet can already pay', async () => {
    const { minter, world } = build({ balance: NEED });
    const result = await minter.mint({ agentId: 'agent-1' });
    expect(world.sent).toEqual([]);
    expect(result.gasTopUpTxHash).toBeNull();
    expect(world.registeredBy).toEqual([AGENT]);
  });

  it('the preview names the agent as registrant and the minter as gas payer, and sends nothing', async () => {
    const { minter, world } = build({});
    const preview = await minter.previewMint({ agentId: 'agent-1' });
    expect(preview).toEqual({ estimatedGas: GAS, registrantAddress: AGENT, gasFunderAddress: MINTER });
    expect(world.sent).toEqual([]);
    expect(world.registeredBy).toEqual([]);
  });
});

describe('refused before anything is sent, so the identity never lands on a shared address', () => {
  it.each([
    ['the agent has no custodied key', { agentKey: null }, /has no wallet of its own/],
    ['the key is not for the recorded wallet', { walletAddress: MINTER }, /is not for its recorded wallet/],
    ['the agent key is the minter key', { agentKey: MINTER_KEY, walletAddress: null }, /refusing to mint to a shared address/],
    ['the gas top-up would exceed the cap', { price: (MAX_GAS_TOPUP_WEI / GAS) + 1n }, /over the .* ETH cap/],
    ['gas is needed off Base Sepolia', { chainId: 8453 }, /top-ups run only on chain 84532/],
  ] as const)('%s', async (_name, opts, message) => {
    const { minter, world } = build(opts as Parameters<typeof build>[0]);
    await expect(minter.mint({ agentId: 'agent-1' })).rejects.toThrow(message);
    expect(world.registeredBy).toEqual([]);
    expect(world.sent).toEqual([]);
    expect(world.updates).toEqual([]);
  });
});

describe('the read-back says what the chain says, in three outcomes', () => {
  it('FAILED when the chain reports another owner, and the mint is still recorded so it is not repeated', async () => {
    const { minter, world } = build({ ownerOf: async () => MINTER });
    const result = await minter.mint({ agentId: 'agent-1' });
    expect(result.selfOwned).toBe('FAILED');
    expect(world.updates).toHaveLength(1);
  });

  it('FAILED when the token acts from another wallet', async () => {
    const { minter } = build({ agentWallet: async () => MINTER });
    expect((await minter.mint({ agentId: 'agent-1' })).selfOwned).toBe('FAILED');
  });

  it('NOT_CHECKED when the RPC cannot be reached, never a pass', async () => {
    const { minter } = build({ ownerOf: async () => { throw Object.assign(new Error('403'), { code: 'SERVER_ERROR' }); } });
    expect((await minter.mint({ agentId: 'agent-1' })).selfOwned).toBe('NOT_CHECKED');
  });
});

describe('the route answers a refusal with 409, not 500', () => {
  it('a mint for an agent with no wallet of its own is refused with the reason', async () => {
    const { minter } = build({ agentKey: null });
    const app = express();
    app.use(express.json());
    const before = process.env.ERC8004_MINTER_PRIVATE_KEY;
    const beforeKeys = process.env.REPID_API_KEYS;
    process.env.ERC8004_MINTER_PRIVATE_KEY = MINTER_KEY;
    // Since F-6 only the operator or the agent's own key may mint; this test is about the 409.
    process.env.REPID_API_KEYS = 'operator-key:pro';
    try {
      const router = createAgentsOnchainRouter({} as any);
      // Swap in the fake minter the router would otherwise build from env.
      const spy = jestSpyMint(minter);
      app.use('/api/v1/agents', router);
      const res = await request(app).post('/api/v1/agents/agent-1/mint').set('x-api-key', 'operator-key').send({});
      spy.restore();
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/has no wallet of its own/);
    } finally {
      if (before === undefined) delete process.env.ERC8004_MINTER_PRIVATE_KEY;
      else process.env.ERC8004_MINTER_PRIVATE_KEY = before;
      if (beforeKeys === undefined) delete process.env.REPID_API_KEYS;
      else process.env.REPID_API_KEYS = beforeKeys;
    }
  });
});

/** The router builds its own minter from env; point the prototype methods at the fake one. */
function jestSpyMint(fake: Erc8004Minter) {
  const proto = Erc8004Minter.prototype as any;
  const original = proto.mint;
  proto.mint = function (this: unknown, req: unknown) {
    return original.call(fake, req);
  };
  return { restore: () => { proto.mint = original; } };
}
