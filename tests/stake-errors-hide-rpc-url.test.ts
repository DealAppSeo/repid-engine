/**
 * The stake routes return the deposit check's `reason` and the refund's `note` to the caller.
 * Both used to carry the raw ethers message, and ethers puts the RPC URL in it (`requestUrl`),
 * with the provider key in that URL's path: any registered user could read the operator's RPC
 * key from a failed claim (Strix on #1568). These tests plant a keyed URL in each RPC failure and
 * require that neither the key nor any URL reaches the result.
 */

const mockConfig = {
  stakeEscrowSignerKey: null as string | null,
  stakeEscrowAddress: '0x1111111111111111111111111111111111111111',
  usdcTokenAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  baseSepoliaRpc: 'http://localhost:0',
  stakeMinConfirmations: 1,
};
jest.mock('../src/config', () => ({ config: mockConfig }));

import { verifyDeposit, __setProviderFactory, hideUrls, type EthProviderLike } from '../src/services/deposit-verifier';
import { escrowRefund, __setEscrowSender, RefundBroadcastUnconfirmed } from '../src/services/escrow-refunder';

// Low-entropy on purpose, so no secret scanner flags the file; the shape is what matters.
const KEY = 'k' + 'X'.repeat(31);
const URL_WITH_KEY = `https://base-sepolia.example.invalid/v2/${KEY}`;
/** The shape of an ethers v6 FetchRequest failure: the URL rides in `info.requestUrl`. */
const ETHERS_MESSAGE = `server response 401 Unauthorized (request={  }, response={  }, error=null, info={ "requestUrl": "${URL_WITH_KEY}", "responseBody": "Must be authenticated!", "responseStatus": "401 Unauthorized" }, code=SERVER_ERROR, version=6.13.0)`;
const rpcError = () => Object.assign(new Error(ETHERS_MESSAGE), { code: 'SERVER_ERROR' });

const leaks = (text: string | undefined) => (text ?? '').includes(KEY) || /:\/\//.test(text ?? '');

const BASE = {
  txHash: '0x' + 'a'.repeat(64),
  claimedAmount: 1_000_000n,
  escrowAddress: mockConfig.stakeEscrowAddress,
  tokenAddress: mockConfig.usdcTokenAddress,
  minConfirmations: 1,
  fromAddress: '0x2222222222222222222222222222222222222222',
};

function provider(over: Partial<EthProviderLike>): EthProviderLike {
  return {
    send: async () => '0x14a34', // 84532, Base Sepolia
    getTransactionReceipt: async () => { throw rpcError(); },
    getBlockNumber: async () => { throw rpcError(); },
    call: async () => { throw rpcError(); },
    ...over,
  };
}

afterEach(() => {
  __setProviderFactory();
  __setEscrowSender(undefined);
  mockConfig.stakeEscrowSignerKey = null;
});

describe('hideUrls', () => {
  it('removes every URL, whatever the scheme, and keeps the rest of the text', () => {
    const out = hideUrls(`${ETHERS_MESSAGE} and wss://ws.example.invalid/${KEY}?k=1`);
    expect(leaks(out)).toBe(false);
    expect(out).toContain('401 Unauthorized');
    expect(out).toContain('[url hidden]');
  });
});

describe('verifyDeposit: a failed RPC read names the step, never the URL', () => {
  const cases: Array<[string, Partial<EthProviderLike>, RegExp]> = [
    ['eth_chainId', { send: async () => { throw rpcError(); } }, /^eth_chainId unreadable: /],
    ['receipt', {}, /^rpc error fetching receipt: /],
    ['head', { getTransactionReceipt: async () => ({ status: 1, blockNumber: 10, logs: [] }) as never }, /^rpc error fetching head: /],
  ];
  it.each(cases)('%s', async (_name, over, step) => {
    __setProviderFactory(() => provider(over));
    const r = await verifyDeposit(BASE);
    expect(r.verified).toBe(false);
    expect(r.reason).toMatch(step);
    expect(r.reason).toContain('401 Unauthorized');
    expect(leaks(r.reason)).toBe(false);
  });
});

describe('escrowRefund: the note the withdraw caller reads carries no URL', () => {
  it('a send that fails', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async () => { throw rpcError(); });
    const r = await escrowRefund('builder-1', 5_000_000n, '0x2222222222222222222222222222222222222222');
    expect(r.initiated).toBe(false);
    expect(leaks(r.note)).toBe(false);
  });

  it('a broadcast whose outcome is unknown', async () => {
    mockConfig.stakeEscrowSignerKey = 'present';
    __setEscrowSender(async () => { throw new RefundBroadcastUnconfirmed('0xabc', ETHERS_MESSAGE); });
    const r = await escrowRefund('builder-1', 5_000_000n, '0x2222222222222222222222222222222222222222');
    expect(r).toMatchObject({ initiated: true, unconfirmed: true, txHash: '0xabc' });
    expect(leaks(r.note)).toBe(false);
  });
});
