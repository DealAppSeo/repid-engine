/**
 * receipt-loop — LOCAL end-to-end: an ETH payment, an on-chain ERC-8004 feedback receipt that
 * cites it, and the RepID movement the REAL delta functions apply for it.
 *
 * Everything is local and synthetic:
 *   - chain: a Hardhat devnet at E2E_RPC (default http://127.0.0.1:8545, chainId 31337), its
 *     unlocked dev accounts (eth_sendTransaction, no private keys anywhere);
 *   - contracts: IdentityRegistryUpgradeable + ReputationRegistryUpgradeable deployed from the
 *     hyperdag-protocol compiled artifacts (E2E_ARTIFACTS, read only), behind ERC1967Proxy, with
 *     the same HardhatMinimalUUPS -> upgradeToAndCall bootstrap as the contracts' own tests;
 *   - RepID: LOCAL_MODE store in a temp dir, synthetic UUIDs, the real
 *     applyServiceSatisfiedDeltas / applyServiceOutcomeDeltas / applyServiceDisputeResolution;
 *   - egress: a global fetch tripwire; any non-local host throws and is recorded.
 *
 * The stitching (pay -> feedback -> delta) is this driver's, not production's: production does
 * not read the chain before moving RepID. What is real is each leg and the checks below, which
 * re-read every link from the chain and the store rather than trusting the driver's variables.
 *
 * Version note (read from Base Sepolia, 2026-10-20): the live ReputationRegistry implementation has
 * the 8-argument giveFeedback (no x402PaymentProof); the hyperdag-protocol source these artifacts
 * come from has the 9-argument one. The payment -> feedbackHash link checked here is the same in
 * both; the junk-proof probe applies to the source version only.
 *
 * In LOCAL_MODE, applyValidationEvent POSTs {agent_id, score} to the pinned production prover for
 * |delta| >= 5 unless ZKP_SERVICE_URL is set; the tripwire blocks and records it. For a fully
 * local run: ZKP_SERVICE_URL=http://127.0.0.1:9 (the proof call then fails locally, logged).
 *
 * Run: npx ts-node --transpile-only scripts/e2e-local/receipt-loop.ts [out.json]
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Abi,
  type Hex,
} from 'viem';

const RPC = process.env.E2E_RPC ?? 'http://127.0.0.1:8545';
const ARTIFACTS = process.env.E2E_ARTIFACTS ?? 'C:/Users/Cash4/repos/hyperdag-protocol/packages/contracts/artifacts/contracts';

// 1 — env BEFORE the engine modules load (src/config.ts, src/db.ts read env at load).
process.env.LOCAL_MODE = 'true';
process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
const storeDir = mkdtempSync(join(tmpdir(), 'repid-e2e-'));
process.env.LOCAL_STORE_PATH = join(storeDir, 'repid.db');
for (const k of Object.keys(process.env)) {
  if (/^SUPABASE_|^ERC8004_|PRIVATE_KEY|_RPC_URL$|^DATABASE_URL$/.test(k)) delete process.env[k];
}

// 2 — egress tripwire, installed before any client exists.
const { isLocalHost } = require('../../src/selfhost/egress-guard');
const egress = { local: 0, blocked: [] as string[] };
const realFetch = global.fetch;
(global as any).fetch = (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!isLocalHost(url)) {
    egress.blocked.push(url);
    throw new Error(`EGRESS VIOLATION: ${url}`);
  }
  egress.local++;
  return (realFetch as any)(input, init);
};

const { db } = require('../../src/db');
const delta = require('../../src/services/validation-repid-delta');

const chain = defineChain({ id: 31337, name: 'hardhat-local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account: Hex) => createWalletClient({ chain, transport: http(RPC), account });

const art = (file: string, name: string) => JSON.parse(readFileSync(`${ARTIFACTS}/${file}/${name}.json`, 'utf8')) as { abi: Abi; bytecode: Hex };
const MINIMAL = art('HardhatMinimalUUPS.sol', 'HardhatMinimalUUPS');
const PROXY = art('ERC1967Proxy.sol', 'ERC1967Proxy');
const IDENTITY = art('IdentityRegistryUpgradeable.sol', 'IdentityRegistryUpgradeable');
const REPUTATION = art('ReputationRegistryUpgradeable.sol', 'ReputationRegistryUpgradeable');

const results: { check: string; ok: boolean; detail?: unknown }[] = [];
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`}`);
}

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`tx ${hash} reverted`);
  return r;
}

async function deploy(from: Hex, a: { abi: Abi; bytecode: Hex }, args: unknown[] = []) {
  const r = await mined(await wallet(from).deployContract({ abi: a.abi, bytecode: a.bytecode, args } as any));
  return getAddress(r.contractAddress!);
}

/** proxy -> HardhatMinimalUUPS(initialize(arg)) -> upgradeToAndCall(impl, initCall), as the contracts' tests do. */
async function deployRegistry(owner: Hex, impl: { abi: Abi; bytecode: Hex }, minimalArg: Hex, initCall: Hex) {
  const minimal = await deploy(owner, MINIMAL);
  const proxy = await deploy(owner, PROXY, [minimal, encodeFunctionData({ abi: MINIMAL.abi, functionName: 'initialize', args: [minimalArg] })]);
  const real = await deploy(owner, impl);
  await mined(await wallet(owner).writeContract({ address: proxy, abi: MINIMAL.abi, functionName: 'upgradeToAndCall', args: [real, initCall] } as any));
  return proxy;
}

let seq = 0;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function agentRow(id: string) {
  return (await db.from('repid_agents').select('*').eq('id', id).single()).data;
}

async function main() {
  const accounts = (await pub.request({ method: 'eth_accounts' })) as Hex[];
  const [deployer, providerOwner, buyerA, buyerB, stranger] = accounts.map((a) => getAddress(a));
  check('chain is the local devnet (31337)', (await pub.getChainId()) === 31337);

  // --- Contracts -------------------------------------------------------------------------
  const ZERO = '0x0000000000000000000000000000000000000000' as Hex;
  const identity = await deployRegistry(deployer, IDENTITY, ZERO, encodeFunctionData({ abi: IDENTITY.abi, functionName: 'initialize', args: [] }));
  const reputation = await deployRegistry(deployer, REPUTATION, identity, encodeFunctionData({ abi: REPUTATION.abi, functionName: 'initialize', args: [identity] }));
  check('registries deployed and wired', (await pub.readContract({ address: reputation, abi: REPUTATION.abi, functionName: 'getIdentityRegistry' })) === identity, { identity, reputation });

  // --- Provider identity (ERC-8004 agent NFT) ---------------------------------------------
  const regReceipt = await mined(await wallet(providerOwner).writeContract({ address: identity, abi: IDENTITY.abi, functionName: 'register', args: ['local://agents/e2e-provider'] } as any));
  const registered = regReceipt.logs
    .filter((l) => getAddress(l.address) === identity)
    .map((l) => { try { return decodeEventLog({ abi: IDENTITY.abi, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((e) => e?.eventName === 'Registered') as any;
  const agentId: bigint = registered.args.agentId;
  check('provider registered on-chain', getAddress(registered.args.owner) === providerOwner, { agentId });

  // --- Local RepID store (synthetic agents) -----------------------------------------------
  const P = uuid(0x101), BA = uuid(0x102), BB = uuid(0x103), BC = uuid(0x104);
  for (const [id, name, wallet_address, token] of [
    [P, 'E2E-PROVIDER', providerOwner, agentId.toString()],
    [BA, 'E2E-BUYER-A', buyerA, null],
    [BB, 'E2E-BUYER-B', buyerB, null],
    [BC, 'E2E-BUYER-CONTROL', stranger, null],
  ] as const) {
    await db.from('repid_agents').insert({ id, agent_name: name, current_repid: 500, tier: 'PROBATIONARY', activity_30d: 10, constitution: {}, wallet_address, erc8004_token_id: token });
  }

  /** One exchange: buyer pays the provider's owner, records feedback citing the payment, store rows link it. */
  async function exchange(o: { key: string; buyer: Hex; buyerAgent: string; eth: string; simulated: boolean; value: bigint; tag2: string }) {
    const pay = await mined(await wallet(o.buyer).sendTransaction({ to: providerOwner, value: parseEther(o.eth) } as any));
    const settlementId = uuid(0x200 + ++seq);
    const contractId = uuid(0x300 + seq);
    await db.from('x402_settlements').insert({ id: settlementId, tx_hash: pay.transactionHash, chain_id: 31337, amount_wei: parseEther(o.eth).toString(), payer: o.buyer, payee: providerOwner, is_simulated: o.simulated });
    await db.from('service_contracts').insert({ id: contractId, provider_agent_id: P, buyer_agent_id: o.buyerAgent, x402_payment_id: settlementId, metadata: {}, payload: {} });
    const fb = await mined(await wallet(o.buyer).writeContract({
      address: reputation,
      abi: REPUTATION.abi,
      functionName: 'giveFeedback',
      // feedbackHash = the payment's tx hash; x402PaymentProof = the same 32 bytes (the contract stores it, does not check it).
      args: [agentId, o.value, 0, 'service', o.tag2, '', `local://contracts/${contractId}`, pay.transactionHash, pay.transactionHash],
    } as any));
    return { key: o.key, pay, fb, contractId, settlementId, contract: { id: contractId, provider_agent_id: P, buyer_agent_id: o.buyerAgent } };
  }

  // --- Scenario A: satisfied exchange --------------------------------------------------------
  const A = await exchange({ key: 'A-satisfied', buyer: buyerA, buyerAgent: BA, eth: '0.01', simulated: false, value: 95n, tag2: 'satisfied' });
  await delta.applyServiceSatisfiedDeltas(A.contract, 0.95);
  const raterA = (await agentRow(BA)).current_repid;
  const outA = await delta.applyServiceOutcomeDeltas(A.contract, 'good', raterA);

  // --- Scenario B: failed exchange, provider at fault ------------------------------------
  const B = await exchange({ key: 'B-provider-at-fault', buyer: buyerB, buyerAgent: BB, eth: '0.005', simulated: false, value: -80n, tag2: 'provider_at_fault' });
  const raterB = (await agentRow(BB)).current_repid;
  const outB = await delta.applyServiceOutcomeDeltas(B.contract, 'bad', raterB);
  await delta.applyServiceDisputeResolution(B.contract, 'provider_at_fault');

  // --- Control C: same legs, settlement flagged simulated -> the gate must zero RepID -------
  const C = await exchange({ key: 'C-simulated-control', buyer: stranger, buyerAgent: BC, eth: '0.001', simulated: true, value: 100n, tag2: 'satisfied' });
  await delta.applyServiceSatisfiedDeltas(C.contract, 1);
  const outC = await delta.applyServiceOutcomeDeltas(C.contract, 'good', 2000);
  await delta.applyServiceDisputeResolution(C.contract, 'provider_at_fault');

  // --- Verification: re-read every link from the chain and the store ---------------------
  const events = (await db.from('repid_score_events').select('*').eq('agent_id', P)).data
    .concat((await db.from('repid_score_events').select('*').eq('agent_id', BA)).data)
    .concat((await db.from('repid_score_events').select('*').eq('agent_id', BB)).data)
    .concat((await db.from('repid_score_events').select('*').eq('agent_id', BC)).data);
  const ev = (contractId: string, agent: string) =>
    events.filter((e: any) => (e.metadata?.contract_id ?? e.event_metadata?.contract_id) === contractId && e.agent_id === agent).map((e: any) => ({ type: e.event_type, delta: e.delta }));

  for (const x of [A, B, C]) {
    // payment leg, from the chain
    const tx = await pub.getTransaction({ hash: x.pay.transactionHash });
    const rc = await pub.getTransactionReceipt({ hash: x.pay.transactionHash });
    const before = (addr: Hex) => pub.getBalance({ address: addr, blockNumber: rc.blockNumber - 1n });
    const after = (addr: Hex) => pub.getBalance({ address: addr, blockNumber: rc.blockNumber });
    const payee = getAddress(tx.to!);
    const payer = getAddress(tx.from);
    const gas = rc.gasUsed * rc.effectiveGasPrice;
    check(`${x.key}: payment receipt success, payee +value exactly, payer -(value+gas) exactly`,
      rc.status === 'success' && payee === providerOwner &&
      (await after(payee)) - (await before(payee)) === tx.value &&
      (await before(payer)) - (await after(payer)) === tx.value + gas,
      { eth: formatEther(tx.value), gasWei: gas, block: rc.blockNumber });

    // store leg: contract -> settlement -> tx hash
    const contract = (await db.from('service_contracts').select('*').eq('id', x.contractId).single()).data;
    const settlement = (await db.from('x402_settlements').select('*').eq('id', contract.x402_payment_id).single()).data;
    check(`${x.key}: store settlement cites the payment tx`, settlement.tx_hash === x.pay.transactionHash && getAddress(settlement.payer) === payer);

    // feedback leg, from the chain: NewFeedback by the payer for the provider, feedbackHash = payment tx
    const logs = (await pub.getTransactionReceipt({ hash: x.fb.transactionHash })).logs
      .filter((l) => getAddress(l.address) === reputation)
      .map((l) => decodeEventLog({ abi: REPUTATION.abi, data: l.data, topics: l.topics }) as any)
      .filter((e) => e.eventName === 'NewFeedback');
    const nf = logs[0]?.args;
    check(`${x.key}: on-chain NewFeedback by the payer, for the provider's agent, feedbackHash = payment tx`,
      logs.length === 1 && nf.agentId === agentId && getAddress(nf.clientAddress) === payer && nf.feedbackHash === x.pay.transactionHash,
      { value: nf?.value, tag2: nf?.tag2, feedbackTx: x.fb.transactionHash });
    const stored = (await pub.readContract({ address: reputation, abi: REPUTATION.abi, functionName: 'readFeedback', args: [agentId, payer, nf.feedbackIndex] })) as any[];
    check(`${x.key}: readFeedback returns the same value, not revoked`, stored[0] === nf.value && stored[4] === false);
  }

  // RepID legs, from the store
  const sat = delta.SERVICE_SATISFIED_DELTA_BASE;
  const dis = delta.SERVICE_DISPUTE_DELTAS.provider_at_fault;
  const expectA = [
    { type: 'SERVICE_SATISFIED', delta: Math.round(sat.provider * 0.95) },
    { type: 'SERVICE_OUTCOME', delta: Math.round(delta.SERVICE_OUTCOME_BASE.good * delta.computeRaterWeight(raterA)) },
  ];
  check('A: provider RepID events = T2 satisfied + T3 good (rater-weighted)', JSON.stringify(ev(A.contractId, P)) === JSON.stringify(expectA), { got: ev(A.contractId, P), raterA, outcome: outA });
  check('A: buyer RepID event = T2 buyer share', JSON.stringify(ev(A.contractId, BA)) === JSON.stringify([{ type: 'SERVICE_SATISFIED', delta: Math.round(sat.buyer * 0.95) }]), { got: ev(A.contractId, BA) });

  const expectB = [
    { type: 'SERVICE_OUTCOME', delta: Math.round(delta.SERVICE_OUTCOME_BASE.bad * delta.computeRaterWeight(raterB)) },
    { type: 'VALIDATION_FAILED', delta: dis.provider },
  ];
  check('B: provider RepID events = T3 bad (rater-weighted) + dispute provider_at_fault', JSON.stringify(ev(B.contractId, P)) === JSON.stringify(expectB), { got: ev(B.contractId, P), raterB, outcome: outB });
  check('B: buyer RepID event = dispute refund share', JSON.stringify(ev(B.contractId, BB)) === JSON.stringify([{ type: 'SERVICE_FULFILLED', delta: dis.buyer }]), { got: ev(B.contractId, BB) });

  check('C: simulated settlement moves no RepID (T2 events are 0, T3 and dispute write nothing)',
    ev(C.contractId, P).every((e: any) => e.delta === 0) && ev(C.contractId, BC).every((e: any) => e.delta === 0) && outC.providerDelta === 0,
    { provider: ev(C.contractId, P), buyer: ev(C.contractId, BC) });

  const final = await Promise.all([P, BA, BB, BC].map(agentRow));
  for (const a of final) {
    const mine = events.filter((e: any) => e.agent_id === a.id);
    const last = mine[mine.length - 1];
    check(`${a.agent_name}: current_repid equals its last event's repid_after`, last ? a.current_repid === last.repid_after : a.current_repid === 500, { from: 500, to: a.current_repid, events: mine.length });
  }

  // --- Negative probes on the registry ---------------------------------------------------
  let selfErr = '';
  try {
    await pub.simulateContract({ account: providerOwner, address: reputation, abi: REPUTATION.abi, functionName: 'giveFeedback', args: [agentId, 100n, 0, 'service', 'satisfied', '', '', ('0x' + '00'.repeat(32)) as Hex, '0x'] } as any);
  } catch (e: any) {
    selfErr = String(e.shortMessage ?? e.message);
  }
  check('probe: the provider cannot rate itself (registry rejects self-feedback)', /Self-feedback not allowed/.test(selfErr), selfErr.split('\n')[0]);

  // A junk "payment proof" with no payment behind it: does the registry give it the 2x x402 weight?
  const junkClient = getAddress(accounts[5]);
  await mined(await wallet(junkClient).writeContract({ address: reputation, abi: REPUTATION.abi, functionName: 'giveFeedback', args: [agentId, 100n, 0, 'probe', 'junk-proof', '', '', ('0x' + '00'.repeat(32)) as Hex, '0x01'] } as any));
  const [junkCount] = (await pub.readContract({ address: reputation, abi: REPUTATION.abi, functionName: 'getSummary', args: [agentId, [junkClient], 'probe', 'junk-proof'] })) as any[];
  check('probe (finding, expected to show the gap): a 1-byte junk x402PaymentProof, no payment, still counts at 2x weight', junkCount === 2n, { count: junkCount });

  // --- Egress -------------------------------------------------------------------------------
  check('egress: zero non-local requests (tripwire saw the local chain traffic)', egress.blocked.length === 0 && egress.local > 0, egress);

  const failed = results.filter((r) => !r.ok);
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify({ chainId: 31337, identity, reputation, agentId, scenarios: [A, B, C].map((x) => ({ key: x.key, paymentTx: x.pay.transactionHash, paymentBlock: x.pay.blockNumber, feedbackTx: x.fb.transactionHash, feedbackBlock: x.fb.blockNumber })), final: final.map((a) => ({ agent: a.agent_name, repid: a.current_repid })), results, egress }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => {
    try { db?.close?.(); } catch { /* ignore */ }
  });
