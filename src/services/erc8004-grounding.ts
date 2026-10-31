/**
 * Is one ERC-8004 feedback entry grounded in a payment from the rater to the rated agent? A third
 * implementation of the facts worked out in erc-8004/erc-8004-contracts#99 (AgenticFinanceGraph's
 * definition, holistis's agent-receipt-verify, predge-ai's three cases), written from the thread's
 * description and not from either implementation's code, so agreement between them means something.
 *
 * Every fact is 'true', 'false' or 'not_measured'. A read that could not be made is not_measured,
 * never false. `grounded` is 'yes' only when the four core facts are true: raterIsPayer,
 * paidIsBoundWallet (the binding read at the feedback block), paymentBeforeFeedback and
 * raterNotOwnerOrOperator. Any core fact false is 'no'; otherwise 'not_measured'.
 *
 * Payer and payee come from a stablecoin Transfer log, never from the transaction's `from`: x402
 * settles through a facilitator, and a Transfer of a token anyone can mint proves nothing.
 *
 * Not checked here: whether the same payment backs other feedback entries. One transaction cannot
 * show that; a consumer counting grounded feedback must count each paymentTx once.
 *
 * Reads go through `Rpc`, so a run can be recorded and replayed offline (tests/fixtures/grounding).
 * The tape format is the one agent-receipt-verify uses: [JSON.stringify([method, params]), result].
 *
 * Twin: trustshell src/lib/erc8004-grounding.ts (the portable `trustshell erc8004` command). Both
 * replay the same tapes, so a change to one that the other does not make fails a test.
 */
import { ethers } from 'ethers';

export type Fact = 'true' | 'false' | 'not_measured';
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export const CORE_FACTS = ['raterIsPayer', 'paidIsBoundWallet', 'paymentBeforeFeedback', 'raterNotOwnerOrOperator'] as const;
export const FACTS = [
  ...CORE_FACTS,
  'paidIsBoundWalletAtPayment',
  'paidIsBoundWalletNow',
  'paymentAfterRegistration',
  'noReturnTransfer',
] as const;
export type FactName = (typeof FACTS)[number];

export interface GroundingNetwork {
  identity: string;
  reputation: string;
  /** Tokens whose Transfer counts as payment. Anything else is not a payment, however it looks. */
  stablecoins: string[];
  rpc: string;
}

/**
 * Official ERC-8004 deployments, read from the chain 2026-10-31. USDC is the only payment token.
 * The default RPCs are Base's own: on 2026-10-31 they answered receipts and eth_call at old blocks,
 * where publicnode answered null (Sepolia) or asked for a token (mainnet).
 */
export const GROUNDING_NETWORKS: Record<string, GroundingNetwork> = {
  'eip155:84532': {
    identity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    reputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    stablecoins: ['0x036CbD53842c5426634e7929541eC2318f3dCF7e'],
    rpc: 'https://sepolia.base.org',
  },
  'eip155:8453': {
    identity: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    reputation: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    stablecoins: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    rpc: 'https://mainnet.base.org',
  },
};

export interface GroundingResult {
  feedbackTx: string;
  network: string;
  agentId: string | null;
  rater: string | null;
  paymentTx: string | null;
  /** Where paymentTx came from: given by the caller, the feedbackHash, or the proofOfPayment in the committed file. */
  paymentSource: 'given' | 'feedbackHash' | 'file' | null;
  payee: string | null;
  amount: string | null;
  facts: Record<FactName, Fact>;
  detail: Partial<Record<FactName, string>>;
  grounded: 'yes' | 'no' | 'not_measured';
}

const ABI = new ethers.Interface([
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)',
]);
const NEW_FEEDBACK = ABI.getEvent('NewFeedback')!.topicHash;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ZERO = ethers.ZeroAddress;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const topicAddr = (t: string) => ethers.getAddress('0x' + t.slice(26));

interface Log { address: string; topics: string[]; data: string }
interface Receipt { status: string; blockNumber: string; transactionIndex: string; logs: Log[] }

/** A JSON-RPC error. `reverted` separates "the call reverted" (an answer) from "we could not ask". */
export class RpcError extends Error {
  constructor(message: string, readonly reverted: boolean) {
    super(message);
  }
}

export function httpRpc(url: string, timeoutMs = 20_000): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new RpcError(body.error.message ?? 'rpc error', /revert/i.test(body.error.message ?? ''));
    return body.result;
  };
}

export type Tape = Array<[string, { result?: unknown; error?: string; resultaat?: unknown; fout?: string }]>;

/** Wraps an Rpc and writes every call and its answer to `tape`. */
export function recordingRpc(inner: Rpc, tape: Tape): Rpc {
  return async (method, params) => {
    const key = JSON.stringify([method, params]);
    try {
      const result = await inner(method, params);
      tape.push([key, { result }]);
      return result;
    } catch (e) {
      if (e instanceof RpcError && e.reverted) tape.push([key, { error: e.message }]);
      throw e;
    }
  };
}

/** Answers only from a tape. A call not on it throws a non-revert error, so its fact is not_measured. */
export function replayRpc(tape: Tape): Rpc {
  const map = new Map(tape);
  return async (method, params) => {
    const hit = map.get(JSON.stringify([method, params]));
    if (!hit) throw new RpcError(`not on the tape: ${method}`, false);
    const err = hit.error ?? hit.fout;
    if (err !== undefined) throw new RpcError(err, /revert/i.test(err));
    return hit.result !== undefined ? hit.result : hit.resultaat;
  };
}

const hexBlock = (n: bigint) => '0x' + n.toString(16);

/** Reads a feedbackURI. The caller owns the fetch policy (scripts/verify-feedback-write.ts: public https only). */
export type FileFetcher = (uri: string) => Promise<{ status: number; body: Uint8Array } | { error: string }>;

export async function groundFeedback(
  rpc: Rpc,
  networkId: string,
  feedbackTx: string,
  opts: { paymentTx?: string; fetchFile?: FileFetcher } = {},
): Promise<GroundingResult> {
  const net = GROUNDING_NETWORKS[networkId];
  if (!net) throw new Error(`unknown network ${networkId}; known: ${Object.keys(GROUNDING_NETWORKS).join(', ')}`);
  const facts = Object.fromEntries(FACTS.map((f) => [f, 'not_measured'])) as Record<FactName, Fact>;
  const detail: GroundingResult['detail'] = {};
  const out: GroundingResult = {
    feedbackTx: feedbackTx.toLowerCase(), network: networkId, agentId: null, rater: null,
    paymentTx: null, paymentSource: null, payee: null, amount: null, facts, detail, grounded: 'not_measured',
  };
  const set = (f: FactName, v: Fact, why: string) => {
    facts[f] = v;
    detail[f] = why;
  };
  const receipt = async (tx: string) => (await rpc('eth_getTransactionReceipt', [tx.toLowerCase()])) as Receipt | null;
  /** eth_call at a block: the decoded value, 'reverted', or null when the read could not be made. */
  const call = async (fn: string, args: unknown[], block: string): Promise<unknown | 'reverted' | null> => {
    try {
      const raw = (await rpc('eth_call', [{ to: net.identity, data: ABI.encodeFunctionData(fn, args) }, block])) as string;
      if (!raw || raw === '0x') return 'reverted';
      return ABI.decodeFunctionResult(fn, raw)[0];
    } catch (e) {
      return e instanceof RpcError && e.reverted ? 'reverted' : null;
    }
  };

  let fb: Receipt | null;
  try {
    fb = await receipt(feedbackTx);
  } catch (e) {
    for (const f of FACTS) detail[f] = `feedback receipt could not be read: ${(e as Error).message}`;
    return out;
  }
  const log = fb?.logs.find((l) => same(l.address, net.reputation) && l.topics[0] === NEW_FEEDBACK);
  if (!fb || fb.status !== '0x1' || !log) {
    // A null receipt is "this node has no record", not "no feedback": pruned nodes answer null for old blocks.
    const why = !fb ? 'the RPC returned no receipt (not found, or pruned on this node)'
      : fb.status !== '0x1' ? 'the feedback transaction did not succeed'
        : 'no NewFeedback from the Reputation Registry in this transaction';
    for (const f of FACTS) detail[f] = why;
    return out;
  }
  const ev = ABI.parseLog(log)!;
  const agentId = ev.args.agentId as bigint;
  const rater = ev.args.clientAddress as string;
  out.agentId = agentId.toString();
  out.rater = rater;
  const fbBlock = hexBlock(BigInt(fb.blockNumber));

  // Owner or operator, read at the feedback block. Needs no payment.
  const authorized = await call('isAuthorizedOrOwner', [rater, agentId], fbBlock);
  if (typeof authorized === 'boolean') {
    set('raterNotOwnerOrOperator', authorized ? 'false' : 'true', authorized ? 'the rater is the owner or an approved operator' : 'the rater is neither owner nor operator');
  } else detail.raterNotOwnerOrOperator = 'isAuthorizedOrOwner could not be read at the feedback block';

  // The payment: given by the caller, else the feedbackHash read as a transaction hash, else the
  // proofOfPayment in the file the feedbackHash commits to (a file that does not hash to it is not read).
  const feedbackHash = ev.args.feedbackHash as string;
  out.paymentSource = opts.paymentTx ? 'given' : 'feedbackHash';
  let paymentTx = (opts.paymentTx ?? feedbackHash).toLowerCase();
  let pay: Receipt | null = null;
  try {
    pay = /^0x0{64}$/.test(paymentTx) ? null : await receipt(paymentTx);
    if (!pay && !opts.paymentTx && opts.fetchFile && ev.args.feedbackURI) {
      const file = await opts.fetchFile(ev.args.feedbackURI as string);
      if ('body' in file && file.status === 200 && same(ethers.keccak256(file.body), feedbackHash)) {
        let proof: { txHash?: string } | undefined;
        try {
          proof = (JSON.parse(Buffer.from(file.body).toString('utf8')) as { proofOfPayment?: { txHash?: string } }).proofOfPayment;
        } catch {
          proof = undefined; // not JSON: no payment named
        }
        if (proof?.txHash && /^0x[0-9a-fA-F]{64}$/.test(proof.txHash)) {
          out.paymentSource = 'file';
          paymentTx = proof.txHash.toLowerCase();
          pay = await receipt(paymentTx);
        }
      }
    }
  } catch (e) {
    const why = `payment receipt could not be read: ${(e as Error).message}`;
    for (const f of FACTS) if (f !== 'raterNotOwnerOrOperator') detail[f] = why;
    out.grounded = verdict(facts);
    return out;
  }
  if (!pay || pay.status !== '0x1') {
    const why = pay
      ? `payment ${paymentTx} did not succeed`
      : out.paymentSource === 'feedbackHash'
        ? opts.fetchFile
          ? 'neither the feedbackHash nor the committed file names a payment on this chain (it may be a receipt commitment); name the payment to check it'
          : 'the feedbackHash is not a transaction on this chain (it may be a receipt commitment or a file hash; the file was not read); name the payment to check it'
        : `the RPC returned no receipt for payment ${paymentTx} (not found, or pruned on this node)`;
    for (const f of FACTS) if (f !== 'raterNotOwnerOrOperator') detail[f] = why;
    out.grounded = verdict(facts);
    return out;
  }
  out.paymentTx = paymentTx;

  const transfers = pay.logs
    .filter((l) => l.topics[0] === TRANSFER && l.topics.length === 3 && net.stablecoins.some((s) => same(s, l.address)))
    .map((l) => ({ from: topicAddr(l.topics[1]!), to: topicAddr(l.topics[2]!), amount: BigInt(l.data) }));
  const fromRater = transfers.filter((t) => same(t.from, rater) && t.amount > 0n);
  set('raterIsPayer', fromRater.length ? 'true' : 'false',
    fromRater.length ? `the rater sent ${fromRater[0]!.amount} base units of USDC` : `no USDC Transfer from the rater in the payment (${transfers.length} USDC transfers seen)`);
  // The payee: whom the rater paid, else whom the payment paid at all.
  const paid = (fromRater.length ? fromRater : transfers).map((t) => t.to);
  out.payee = paid[0] ?? null;
  out.amount = (fromRater[0] ?? transfers[0])?.amount.toString() ?? null;
  const payees = new Set(paid.map((a) => a.toLowerCase()));
  const returned = transfers.some((t) => payees.has(t.from.toLowerCase()) && same(t.to, rater));
  set('noReturnTransfer', returned ? 'false' : 'true', returned ? 'the payee sent USDC back to the rater in the same transaction' : 'nothing sent back to the rater in the same transaction');

  const payBlock = hexBlock(BigInt(pay.blockNumber));
  const before = BigInt(pay.blockNumber) < BigInt(fb.blockNumber)
    || (pay.blockNumber === fb.blockNumber && BigInt(pay.transactionIndex) < BigInt(fb.transactionIndex));
  set('paymentBeforeFeedback', before ? 'true' : 'false', `payment block ${BigInt(pay.blockNumber)}, feedback block ${BigInt(fb.blockNumber)}`);

  const registered = await call('ownerOf', [agentId], payBlock);
  if (registered === 'reverted') set('paymentAfterRegistration', 'false', 'the agent did not exist at the payment block');
  else if (typeof registered === 'string') set('paymentAfterRegistration', 'true', 'the agent existed at the payment block');
  else detail.paymentAfterRegistration = 'ownerOf could not be read at the payment block';

  // The binding, read at three times. The core fact is the feedback block; #99 has not settled which reading counts.
  for (const [fact, block, when] of [
    ['paidIsBoundWallet', fbBlock, 'the feedback block'],
    ['paidIsBoundWalletAtPayment', payBlock, 'the payment block'],
    ['paidIsBoundWalletNow', 'latest', 'the latest block'],
  ] as const) {
    const wallet = await call('getAgentWallet', [agentId], block);
    if (wallet === null) detail[fact] = `getAgentWallet could not be read at ${when}`;
    else if (wallet === 'reverted') {
      // A revert is "no wallet" only when the agent did not exist yet; otherwise the registry may predate getAgentWallet.
      if (block === payBlock && facts.paymentAfterRegistration === 'false') set(fact, 'false', `the agent did not exist at ${when}`);
      else detail[fact] = `getAgentWallet reverted at ${when} (the registry may predate it there)`;
    } else if (same(wallet as string, ZERO)) set(fact, 'false', `no wallet bound at ${when}`);
    else set(fact, payees.has((wallet as string).toLowerCase()) ? 'true' : 'false', `bound wallet at ${when}: ${wallet}`);
  }

  out.grounded = verdict(facts);
  return out;
}

export function verdict(facts: Record<FactName, Fact>): GroundingResult['grounded'] {
  if (CORE_FACTS.some((f) => facts[f] === 'false')) return 'no';
  return CORE_FACTS.every((f) => facts[f] === 'true') ? 'yes' : 'not_measured';
}
