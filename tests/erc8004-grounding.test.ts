/**
 * Grounded feedback (src/services/erc8004-grounding.ts), offline.
 *
 * 1. Six live runs recorded from Base and Base Sepolia on 2026-10-31 replay to the same result.
 * 2. Those results agree with the two other implementations in erc-8004/erc-8004-contracts#99:
 *    the verdict each case's author wrote down before recording, and agent-receipt-verify's facts.
 * 3. Attacks and failures on a fake chain: a minted token is not a payment, a refund is caught,
 *    an owner rating itself is not grounded, and a read we could not make is never "false".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { GROUNDING_NETWORKS, groundFeedback, replayRpc, RpcError, type Fact, type Rpc, type Tape } from '../src/services/erc8004-grounding';

const FIX = join(__dirname, 'fixtures', 'grounding');
const load = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as {
  feedbackTx: string; network: string; paymentTx: string | null; result: { facts: Record<string, Fact>; grounded: string }; tape: Tape;
};

/**
 * What others said, before or apart from us. `expected` is the case author's written verdict
 * (#99 comments 6368637291, 6397094496, 6418209724); `theirs` is agent-receipt-verify's measured
 * facts in its vectors/grounding (Apache-2.0, holistis). Only facts they report are compared.
 */
const OTHERS: Record<string, { expected: Record<string, Fact>; theirs: Record<string, Fact>; grounded: string }> = {
  'afg-positive-agent-1085288': {
    expected: { raterIsPayer: 'true', paidIsBoundWallet: 'true', paymentBeforeFeedback: 'true', raterNotOwnerOrOperator: 'true' },
    theirs: { raterIsPayer: 'true', paidIsBoundWallet: 'true', paymentBeforeFeedback: 'true', raterNotOwnerOrOperator: 'true' },
    grounded: 'yes',
  },
  'afg-negative-agent-524087': {
    expected: { raterIsPayer: 'false', paidIsBoundWallet: 'false' },
    theirs: { raterIsPayer: 'false', paidIsBoundWallet: 'false', paymentBeforeFeedback: 'true', raterNotOwnerOrOperator: 'true' },
    grounded: 'no',
  },
  'predge-case1-agent-10402': {
    expected: { raterIsPayer: 'true', paidIsBoundWallet: 'false', paidIsBoundWalletAtPayment: 'true', paymentAfterRegistration: 'true' },
    theirs: { raterIsPayer: 'true', paidIsBoundWallet: 'false', paymentBeforeFeedback: 'true', paymentAfterRegistration: 'true', noReturnTransfer: 'true', paidIsBoundWalletAtPayment: 'true', raterNotOwnerOrOperator: 'true' },
    grounded: 'no',
  },
  'ruiruii-case2-agent-10419': {
    expected: { paidIsBoundWalletAtPayment: 'false', paidIsBoundWallet: 'true', paymentAfterRegistration: 'false' },
    theirs: { raterIsPayer: 'true', paidIsBoundWallet: 'true', paymentBeforeFeedback: 'true', paymentAfterRegistration: 'false', noReturnTransfer: 'true', paidIsBoundWalletAtPayment: 'false', raterNotOwnerOrOperator: 'true' },
    grounded: 'yes',
  },
  'ruiruii-case3-agent-10420': {
    expected: { paidIsBoundWalletAtPayment: 'true', paidIsBoundWallet: 'true', paymentAfterRegistration: 'true' },
    theirs: { raterIsPayer: 'true', paidIsBoundWallet: 'true', paymentBeforeFeedback: 'true', paymentAfterRegistration: 'true', noReturnTransfer: 'true', paidIsBoundWalletAtPayment: 'true', raterNotOwnerOrOperator: 'true' },
    grounded: 'yes',
  },
};

describe('recorded runs replay offline', () => {
  for (const name of [...Object.keys(OTHERS), 'holistis-receipt-agent-10392', 'repid-own-write-agent-5863']) {
    it(name, async () => {
      const f = load(name);
      const r = await groundFeedback(replayRpc(f.tape), f.network, f.feedbackTx, { paymentTx: f.paymentTx ?? undefined });
      expect(r.facts).toEqual(f.result.facts);
      expect(r.grounded).toBe(f.result.grounded);
    });
  }
});

describe('agrees with the other implementations in #99', () => {
  for (const [name, o] of Object.entries(OTHERS)) {
    it(name, () => {
      const ours = load(name).result;
      expect(ours.grounded).toBe(o.grounded);
      for (const [fact, v] of [...Object.entries(o.expected), ...Object.entries(o.theirs)]) expect([fact, ours.facts[fact]]).toEqual([fact, v]);
    });
  }
});

// A fake Base Sepolia: one feedback, one payment, answers built from a small world description.
const NET = GROUNDING_NETWORKS['eip155:84532']!;
const USDC = NET.stablecoins[0]!;
const RATER = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';
const FB = '0x' + 'f'.repeat(64);
const PAY = '0x' + 'a'.repeat(64);
const abi = new ethers.Interface([
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getAgentWallet(uint256) view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function isAuthorizedOrOwner(address,uint256) view returns (bool)',
]);
const transfer = (token: string, from: string, to: string, amount: bigint) => ({
  address: token,
  topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
  data: ethers.toBeHex(amount, 32),
});

function world(w: { rater?: string; transfers?: ReturnType<typeof transfer>[]; down?: boolean; feedbackHash?: string; feedbackURI?: string; walletReverts?: boolean } = {}): Rpc {
  const rater = w.rater ?? RATER;
  const ev = abi.encodeEventLog('NewFeedback', [7n, rater, 0n, 100n, 0, 'x402', 'x402', '', '', w.feedbackURI ?? '', w.feedbackHash ?? PAY]);
  return async (method, params) => {
    if (w.down) throw new RpcError('connect ECONNREFUSED', false);
    if (method === 'eth_getTransactionReceipt') {
      if (params[0] === FB) return { status: '0x1', blockNumber: '0x64', transactionIndex: '0x1', logs: [{ address: NET.reputation, ...ev }] };
      if (params[0] === PAY) return { status: '0x1', blockNumber: '0x63', transactionIndex: '0x0', logs: w.transfers ?? [transfer(USDC, RATER, WALLET, 5000n)] };
      return null;
    }
    const call = abi.parseTransaction({ data: (params[0] as { data: string }).data })!;
    if (call.name === 'getAgentWallet') {
      if (w.walletReverts) throw new RpcError('execution reverted', true);
      return abi.encodeFunctionResult('getAgentWallet', [WALLET]);
    }
    if (call.name === 'ownerOf') return abi.encodeFunctionResult('ownerOf', [OWNER]);
    return abi.encodeFunctionResult('isAuthorizedOrOwner', [call.args[0].toLowerCase() === OWNER.toLowerCase()]);
  };
}

describe('attacks and failures', () => {
  it('a plain paid rating is grounded', async () => {
    expect((await groundFeedback(world(), 'eip155:84532', FB)).grounded).toBe('yes');
  });

  it('a Transfer of a token anyone can mint is not a payment', async () => {
    const junk = '0x9999999999999999999999999999999999999999';
    const r = await groundFeedback(world({ transfers: [transfer(junk, RATER, WALLET, 10n ** 24n)] }), 'eip155:84532', FB);
    expect(r.facts.raterIsPayer).toBe('false');
    expect(r.grounded).toBe('no');
  });

  it('a zero-amount USDC Transfer is not a payment', async () => {
    const r = await groundFeedback(world({ transfers: [transfer(USDC, RATER, WALLET, 0n)] }), 'eip155:84532', FB);
    expect(r.facts.raterIsPayer).toBe('false');
  });

  it('a refund in the same transaction is caught', async () => {
    const r = await groundFeedback(world({ transfers: [transfer(USDC, RATER, WALLET, 5000n), transfer(USDC, WALLET, RATER, 5000n)] }), 'eip155:84532', FB);
    expect(r.facts.noReturnTransfer).toBe('false');
  });

  it('the owner rating its own agent is not grounded, even when it paid', async () => {
    const r = await groundFeedback(world({ rater: OWNER, transfers: [transfer(USDC, OWNER, WALLET, 5000n)] }), 'eip155:84532', FB);
    expect(r.facts.raterNotOwnerOrOperator).toBe('false');
    expect(r.grounded).toBe('no');
  });

  it('a payment to someone other than the bound wallet is not grounded', async () => {
    const r = await groundFeedback(world({ transfers: [transfer(USDC, RATER, OWNER, 5000n)] }), 'eip155:84532', FB);
    expect(r.facts.paidIsBoundWallet).toBe('false');
    expect(r.grounded).toBe('no');
  });

  it('a feedbackHash that is no transaction is not measured, not false', async () => {
    const r = await groundFeedback(world({ feedbackHash: '0x' + 'b'.repeat(64) }), 'eip155:84532', FB);
    expect(r.facts.raterIsPayer).toBe('not_measured');
    expect(r.grounded).toBe('not_measured');
  });

  it('reads the payment from the file the feedbackHash commits to', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ proofOfPayment: { txHash: PAY } }));
    const fetchFile = async () => ({ status: 200, body });
    const r = await groundFeedback(world({ feedbackHash: ethers.keccak256(body), feedbackURI: 'https://x.test/f.json' }), 'eip155:84532', FB, { fetchFile });
    expect(r.paymentSource).toBe('file');
    expect(r.grounded).toBe('yes');
  });

  it('does not read a payment from a file that is not the one committed to', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ proofOfPayment: { txHash: PAY } }));
    const fetchFile = async () => ({ status: 200, body });
    const r = await groundFeedback(world({ feedbackHash: '0x' + 'c'.repeat(64), feedbackURI: 'https://x.test/f.json' }), 'eip155:84532', FB, { fetchFile });
    expect(r.paymentTx).toBeNull();
    expect(r.grounded).toBe('not_measured');
  });

  it('getAgentWallet reverting on an agent that exists is not measured, not "no wallet"', async () => {
    const r = await groundFeedback(world({ walletReverts: true }), 'eip155:84532', FB);
    expect(r.facts.paidIsBoundWallet).toBe('not_measured');
    expect(r.grounded).toBe('not_measured');
  });

  it('an RPC that does not answer is not measured, not false', async () => {
    const r = await groundFeedback(world({ down: true }), 'eip155:84532', FB);
    expect(Object.values(r.facts).every((v) => v === 'not_measured')).toBe(true);
    expect(r.grounded).toBe('not_measured');
  });
});
