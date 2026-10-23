/**
 * ERC-7231 real mint: no default network, and never one that is not Base Sepolia (MAJOR, Sean
 * decides; 2026-10-23). Until then an unset BASE_RPC_URL fell back to https://mainnet.base.org, so
 * setting BASE_ERC7231_REGISTRY alone would have had the deployer key sign on Base MAINNET.
 * ethers is mocked: no test here reaches a node or signs anything.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const mockProviderUrls: string[] = [];
let mockChainId = 84532n;
const mockMintTo = jest.fn(async () => ({ hash: '0xtx', wait: async () => ({ logs: [{}] }) }));

jest.mock('ethers', () => ({
  JsonRpcProvider: jest.fn().mockImplementation((url: string) => {
    mockProviderUrls.push(url);
    return { getNetwork: async () => ({ chainId: mockChainId }) };
  }),
  Wallet: jest.fn().mockImplementation(() => ({})),
  Contract: jest.fn().mockImplementation(() => ({ mintTo: mockMintTo })),
  Interface: jest.fn().mockImplementation(() => ({
    parseLog: () => ({ name: 'Transfer', args: { tokenId: 7n } }),
  })),
}));

let mockStored: unknown = null;
jest.mock('../src/db', () => {
  const tbl: any = {
    select: () => tbl,
    eq: () => tbl,
    update: (row: unknown) => {
      mockStored = row;
      return { eq: async () => ({ data: null, error: null }) };
    },
    maybeSingle: async () => ({ data: { id: 'b1', address: '0xabc', erc7231_token_id: null }, error: null }),
  };
  return { db: { from: () => tbl, rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }) } };
});

import { mintErc7231ForBuilder } from '../src/services/erc7231-mint';

const saved = { ...process.env };
let errorLog: jest.SpyInstance;

beforeEach(() => {
  mockProviderUrls.length = 0;
  mockChainId = 84532n;
  mockMintTo.mockClear();
  mockStored = null;
  process.env.BASE_ERC7231_REGISTRY = '0x0000000000000000000000000000000000007231';
  process.env.DEPLOYER_PRIVATE_KEY = 'test-key-not-real';
  delete process.env.BASE_RPC_URL;
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorLog.mockRestore();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('erc7231-mint, real path', () => {
  it.each([undefined, '', '   '])('BASE_RPC_URL=%j: refuses loudly, builds no provider, signs nothing', async (rpc) => {
    if (rpc !== undefined) process.env.BASE_RPC_URL = rpc;
    const r = await mintErc7231ForBuilder('b1');
    expect(r).toMatchObject({ ok: false, is_simulated: false });
    expect(r.error).toMatch(/BASE_RPC_URL/);
    expect(mockProviderUrls).toEqual([]);
    expect(mockMintTo).not.toHaveBeenCalled();
    expect(mockStored).toBeNull();
    expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/REFUSED/));
  });

  it('an RPC on Base Sepolia (84532) mints', async () => {
    process.env.BASE_RPC_URL = 'https://rpc.example.test';
    const r = await mintErc7231ForBuilder('b1');
    expect(r).toMatchObject({ ok: true, erc7231_token_id: '7', tx_hash: '0xtx', is_simulated: false });
    expect(mockProviderUrls).toEqual(['https://rpc.example.test']);
    expect(mockMintTo).toHaveBeenCalledTimes(1);
  });

  it('names no mainnet RPC anywhere in the mint service', () => {
    const src = readFileSync(resolve(__dirname, '../src/services/erc7231-mint.ts'), 'utf8');
    expect(src).not.toMatch(/mainnet\.base\.org/);
  });
});
