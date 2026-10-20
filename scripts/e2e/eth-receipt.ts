/**
 * eth-receipt — one testnet-ETH exchange plus the ERC-8004 receipt that cites it, on Base Sepolia.
 *
 * The buyer (BASE_SEPOLIA_PRIVATE_KEY) pays the provider's wallet in ETH, then gives client
 * feedback for the provider's ERC-8004 agent. The feedback file is the engine's own format
 * (buildFeedbackFile), with proofOfPayment = that ETH tx, carried as a data: URI so anyone can
 * verify the receipt from the chain alone: feedbackHash = keccak256(file), file.proofOfPayment.txHash
 * = the payment, and the payment tx shows from/to/value.
 *
 * RepID does NOT move from this. The engine scores contract settlements (x402 USDC via
 * scripts/cron/mint-attestation.mjs); nothing ingests client feedback. This is the receipt leg.
 *
 * Every check that can refuse runs BEFORE the ETH moves: chain, amount cap, payee != payer, and a
 * simulated giveFeedback (the registry refuses self-feedback from the agent's owner or operator).
 *
 * Dry run by default. Usage:
 *   npx ts-node --transpile-only scripts/e2e/eth-receipt.ts --agent <tokenId> --to <providerWallet> [--eth 0.0001] [--execute]
 * Env: BASE_SEPOLIA_PRIVATE_KEY (payer), BASE_SEPOLIA_RPC_URL (default https://sepolia.base.org).
 */
import { ethers } from 'ethers';
import { buildFeedbackFile, feedbackHashOf } from '../../src/services/erc8004-feedback-file';

const CHAIN_ID = 84532;
const IDENTITY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REPUTATION = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const MAX_ETH = 0.001;
const TAG1 = 'eth_payment_receipt'; // not 'hyperdag_repid': a 0-100 rating must not mix into RepID-value summaries
const REP_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
];
const ID_ABI = ['function ownerOf(uint256) view returns (address)'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function die(msg: string): never {
  console.error(`[eth-receipt] REFUSED: ${msg}`);
  process.exit(1);
}

async function main() {
  const execute = process.argv.includes('--execute');
  const agentId = arg('agent') ?? die('--agent <tokenId> is required');
  const to = arg('to') ?? die('--to <providerWallet> is required');
  const eth = Number(arg('eth') ?? '0.0001');
  if (!/^\d+$/.test(agentId)) die('--agent must be a token id');
  if (!ethers.isAddress(to)) die('--to is not an address');
  if (!(eth > 0 && eth <= MAX_ETH)) die(`--eth must be > 0 and <= ${MAX_ETH}`);
  const key = (process.env.BASE_SEPOLIA_PRIVATE_KEY || '').trim() || die('BASE_SEPOLIA_PRIVATE_KEY is not set');

  const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org');
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) die(`RPC is chain ${chainId}, not Base Sepolia ${CHAIN_ID}`);
  const wallet = new ethers.Wallet(key, provider);
  const payer = await wallet.getAddress();
  if (ethers.getAddress(to) === payer) die('the payee is the payer');

  const owner = await new ethers.Contract(IDENTITY, ID_ABI, provider).getFunction('ownerOf')(agentId);
  const value = ethers.parseEther(String(eth));
  const balance = await provider.getBalance(payer);
  console.log(`[eth-receipt] payer=${payer} balance=${ethers.formatEther(balance)} ETH`);
  console.log(`[eth-receipt] agent=${agentId} owner=${owner} payee=${to} amount=${eth} ETH`);
  if (balance < value * 2n) die('payer balance is under twice the amount (gas headroom)');

  const rep = new ethers.Contract(REPUTATION, REP_ABI, wallet);
  // Refuse BEFORE paying: a feedback the registry would reject (self-feedback, missing agent) must
  // not leave ETH paid with no receipt. Simulated with a placeholder file of the same shape.
  try {
    await rep.getFunction('giveFeedback').staticCall(agentId, 100, 0, TAG1, 'e2e', '', 'data:,preflight', ethers.ZeroHash);
  } catch (e: any) {
    die(`the registry would reject this feedback (${e.shortMessage ?? e.reason ?? e.message}); nothing was paid`);
  }
  if (!execute) {
    console.log('[eth-receipt] DRY RUN ok: every pre-payment check passed. Re-run with --execute to pay and record.');
    return;
  }

  // 1. pay
  const payTx = await wallet.sendTransaction({ to, value });
  const pay = await payTx.wait();
  if (!pay || pay.status !== 1) die(`payment ${payTx.hash} did not succeed`);
  console.log(`[eth-receipt] paid ${eth} ETH: ${payTx.hash} (block ${pay.blockNumber})`);

  // 2. the receipt: engine-format feedback file citing the payment, hash-committed, as a data: URI
  const file = buildFeedbackFile({
    chainId: CHAIN_ID,
    identityRegistry: IDENTITY,
    agentTokenId: agentId,
    clientAddress: payer,
    createdAt: new Date().toISOString(),
    value: 100,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: 'e2e',
    endpoint: '',
    proofOfPayment: { fromAddress: payer, toAddress: ethers.getAddress(to), chainId: String(CHAIN_ID), txHash: payTx.hash },
  });
  const uri = 'data:application/json;base64,' + Buffer.from(file, 'utf8').toString('base64');
  const fbTx = await rep.getFunction('giveFeedback')(agentId, 100, 0, TAG1, 'e2e', '', uri, feedbackHashOf(file));
  const fb = await fbTx.wait();
  if (!fb || fb.status !== 1) die(`feedback ${fbTx.hash} did not succeed (payment ${payTx.hash} stands)`);
  console.log(`[eth-receipt] feedback: ${fbTx.hash} (block ${fb.blockNumber})`);

  // 3. verify from the chain alone, as a third party would
  const iface = new ethers.Interface(REP_ABI);
  const ev = fb.logs.filter((l) => ethers.getAddress(l.address) === REPUTATION).map((l) => iface.parseLog(l)).find((p) => p?.name === 'NewFeedback');
  if (!ev) die('no NewFeedback in the feedback tx');
  const onChainFile = Buffer.from(String(ev.args.feedbackURI).split(',')[1] ?? '', 'base64').toString('utf8');
  const pop = JSON.parse(onChainFile).proofOfPayment;
  const paid = await provider.getTransaction(pop.txHash);
  const checks: [string, boolean][] = [
    ['NewFeedback is for the agent, from the payer', ev.args.agentId === BigInt(agentId) && ethers.getAddress(ev.args.clientAddress) === payer],
    ['keccak256(file in the event) = feedbackHash', ethers.keccak256(ethers.toUtf8Bytes(onChainFile)) === ev.args.feedbackHash],
    ['proofOfPayment.txHash is the payment', pop.txHash === payTx.hash],
    ['the payment tx: from payer, to payee, exact value', !!paid && ethers.getAddress(paid.from) === payer && ethers.getAddress(paid.to!) === ethers.getAddress(to) && paid.value === value],
  ];
  for (const [k, v] of checks) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  console.log(`https://sepolia.basescan.org/tx/${payTx.hash}\nhttps://sepolia.basescan.org/tx/${fbTx.hash}`);
  process.exitCode = checks.every(([, v]) => v) ? 0 : 1;
}

main().catch((e) => {
  console.error('[eth-receipt] FAIL: ' + (e?.shortMessage ?? e?.message ?? e));
  process.exit(1);
});
