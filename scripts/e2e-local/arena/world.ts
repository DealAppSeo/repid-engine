/**
 * One exchange's world, and the executor that runs a payment through it.
 *
 * A world is: fresh throwaway keys (never written, never printed), a funded buyer, a deployed mock
 * USDC and a decoy token, the pinned experiment policy on disk, the engine's kernel with a durable
 * JSONL ledger and an owner-signed policy per asset, and synthetic agents in the LOCAL_MODE store.
 *
 * The executor (`present`) is the engine's own, in this order, and nothing after a refusal runs:
 *     arena preflight (data checks the kernel cannot express)  ->  x402 authority gate (USDC)
 *     ->  kernel runUnderKernel(tool = send + readback)  ->  settlement classified from the chain.
 * Authorization comes only from the kernel; the preflight and the gate can only refuse.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Wallet, type HDNodeWallet } from 'ethers';
import { getAddress, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAddress, privateKeyToAccount } from 'viem/accounts';
import type { GateDeps } from '../../../src/kernel/types';
import type { TestChain } from './chain';
import {
  ZERO_ADDRESS, assetKey, classifySettlement, npaHashOf, sameAddr, signNpa, stampPolicy, serviceHashOf,
  type ArenaPolicy, type Hex, type Npa, type SignedNpa, type TxReadback,
} from './core';
import type { Engine } from './engine';
import { npaHashOrNull } from '../../../src/services/npa-preflight';
import { preflight, type Presentation, type Refusal, type Tally } from './guard';

export type Sym = 'USDC' | 'ETH';

export interface Attempt {
  label: string;
  at: string;
  npa_hash: string;
  /** The asset and amount the NPA names (what a SETTLED label claims moved). */
  sym: Sym | null;
  amount_raw: string;
  status: 'SETTLED' | 'REFUSED' | 'FAILED' | 'UNKNOWN';
  /** Preflight / gate refusals. Empty when the request reached the kernel. */
  refusals: Refusal[];
  gate: Record<string, unknown> | null;
  /** The kernel's own decision when the request reached it. */
  kernel: { verdict: string; executed: boolean; persisted: boolean; reasons: string[]; tool_error: string | null; receipt_id: string | null; payment_status: string | null; outcome_unrecorded: boolean } | null;
  /** What the kernel ALONE would have said to a request the preflight refused (dry: nothing written, nothing run). */
  kernel_dry: { verdict: string; reasons: string[] } | { skipped: string } | null;
  tx_hash: Hex | null;
  settlement_why: string | null;
  readback: Record<string, unknown> | null;
}

export interface World {
  id: string;
  chain: TestChain;
  engine: Engine;
  dir: string;
  now: () => number;
  keys: { buyer: Hex; seller: Hex; attacker: Hex };
  owner: HDNodeWallet;
  addr: { buyer: Hex; seller: Hex; attacker: Hex; usdc: Hex; decoy: Hex };
  agents: { buyer: { id: string; name: string }; seller: { id: string; name: string } };
  kernelSubjects: Record<Sym, string>;
  policy: ArenaPolicy;
  policyPath: string;
  pinnedPolicyId: string;
  killPath: string;
  ledgerPath: string;
  deps: GateDeps;
  tally: Tally;
  /** Every transaction the executor broadcast, so the oracle can compare it to the chain's own nonce. */
  sends: Array<{ hash: Hex; asset: Hex; to: Hex; amount: bigint }>;
  /** Settled payments the arena itself verified, by tx hash: what a later feedback may cite. */
  settled: Map<string, { npa: Npa; counted: boolean }>;
  attempts: Attempt[];
  funding: { buyerNative: bigint; buyerUsdc: bigint };
  /** The faucet transaction that funded the buyer: a real tx on this chain that is NOT any payment of ours. */
  fundingTx: Hex;
}

export interface WorldOpts {
  chain: TestChain;
  engine: Engine;
  now?: () => number;
  aggregateUsdc?: string;
  aggregateEth?: string;
  evaluatorSha256: string;
  baseDir?: string;
  /** Test seam: where the exchange's throwaway keys come from. Default: a fresh random key each. */
  genKey?: () => Hex;
}

const offlineSignatureChain = { getCode: async () => '0x', call: async () => { throw new Error('arena: the kernel is not allowed to reach a chain for a signature'); } };
export const ARENA_ENV = { network: 'hardhat-local', chain_id: 31337, is_simulated: false } as const;

const isoOf = (ms: number) => new Date(ms).toISOString();

export async function makeWorld(o: WorldOpts): Promise<World> {
  const now = o.now ?? Date.now;
  const nowS = Math.floor(now() / 1000);
  const id = randomUUID();
  const dir = mkdtempSync(join(o.baseDir ?? tmpdir(), 'arena-world-'));

  const gen = o.genKey ?? generatePrivateKey;
  const keys = { buyer: gen(), seller: gen(), attacker: gen() };
  const addr = {
    buyer: getAddress(privateKeyToAddress(keys.buyer)) as Hex,
    seller: getAddress(privateKeyToAddress(keys.seller)) as Hex,
    attacker: getAddress(privateKeyToAddress(keys.attacker)) as Hex,
    usdc: ZERO_ADDRESS,
    decoy: ZERO_ADDRESS,
  };
  const funding = { buyerNative: parseEther('0.05'), buyerUsdc: 100_000_000n };
  const fundingTx = await o.chain.fundNative(addr.buyer, funding.buyerNative);
  addr.usdc = await o.chain.deployToken('Mock USD Coin (L0 arena)', 'USDC');
  addr.decoy = await o.chain.deployToken('Decoy USD Coin (L0 arena)', 'USDC');
  await o.chain.mint(addr.usdc, addr.buyer, funding.buyerUsdc);
  await o.chain.mint(addr.decoy, addr.buyer, funding.buyerUsdc);

  const chainId = await o.chain.chainId();
  const policyPath = join(dir, 'policy.json');
  const killPath = join(dir, 'KILL');
  const policy = stampPolicy({
    level: 0,
    chain_id: chainId,
    assets: [
      { symbol: 'ETH', contract: 'native', decimals: 18 },
      { symbol: 'USDC', contract: addr.usdc, decimals: 6 },
    ],
    wallets: { buyer: [addr.buyer], seller: [addr.seller] },
    counterparties: [addr.seller],
    operations: ['pay'],
    per_tx_max_raw: { USDC: '1000000', ETH: '1000000000000000' },
    aggregate_max_raw: { USDC: o.aggregateUsdc ?? '5000000', ETH: o.aggregateEth ?? '5000000000000000' },
    max_tx_count: 20,
    max_fee_wei: '1000000000000000',
    not_before: nowS - 60,
    expires_at: nowS + 3600,
    kill_switch_path: killPath,
    evaluator_sha256: o.evaluatorSha256,
  });
  writeFileSync(policyPath, JSON.stringify(policy, null, 1));

  // Synthetic agents in the LOCAL_MODE store. The buyer is AUTONOMOUS because that is the tier whose x402
  // ceiling is not gated on stake (and the engine reads no real stake: x402-gate.ts F2); the provider is new.
  const agents = { buyer: { id: randomUUID(), name: `arena-buyer-${id.slice(0, 8)}` }, seller: { id: randomUUID(), name: `arena-seller-${id.slice(0, 8)}` } };
  await o.engine.db.from('repid_agents').insert({ id: agents.buyer.id, agent_name: agents.buyer.name, current_repid: 1500, tier: 'AUTONOMOUS', activity_30d: 10, constitution: {}, wallet_address: addr.buyer, erc8004_token_id: null });
  await o.engine.db.from('repid_agents').insert({ id: agents.seller.id, agent_name: agents.seller.name, current_repid: 500, tier: 'PROBATIONARY', activity_30d: 10, constitution: {}, wallet_address: addr.seller, erc8004_token_id: null });

  // The kernel: one owner-signed policy per asset, because its limits are unit-less raw integers (1 USDC = 1e6,
  // 1 ETH = 1e18) and its policy cannot name an asset. The owner key lives in memory for this world only.
  const owner = Wallet.createRandom();
  const kernelSubjects: Record<Sym, string> = { USDC: randomUUID(), ETH: randomUUID() };
  const ledgerPath = join(dir, 'kernel-ledger.jsonl');
  const ledger = new o.engine.kernel.StoreLedger(o.engine.kernel.createJsonlStore(ledgerPath));
  for (const sym of ['USDC', 'ETH'] as Sym[]) {
    const p = {
      subject: kernelSubjects[sym],
      owner: owner.address,
      actions: ['spend'],
      payees: [addr.seller],
      per_tx_raw: policy.per_tx_max_raw[sym]!,
      daily_raw: policy.aggregate_max_raw[sym]!,
      total_raw: policy.aggregate_max_raw[sym]!,
      expires_at: nowS + 3600,
      nonce: '1',
    };
    const signature = await owner.signTypedData(o.engine.kernel.POLICY_DOMAIN, o.engine.kernel.POLICY_TYPES, o.engine.kernel.policyTypedValue(p));
    await ledger.appendPolicy({ policy: p, signature }, isoOf(now()));
  }
  const w: World = {
    id, chain: o.chain, engine: o.engine, dir, now, keys, owner, addr, agents, kernelSubjects, policy, policyPath, pinnedPolicyId: policy.policy_id, killPath, ledgerPath,
    deps: kernelDeps(ledger, owner.address, now), tally: { spent: {}, count: 0 }, sends: [], settled: new Map(), attempts: [], funding, fundingTx,
  };
  return w;
}

function kernelDeps(ledger: unknown, ownerWallet: string, now: () => number): GateDeps {
  return {
    ledger: ledger as GateDeps['ledger'],
    resolveOwner: async () => ({ status: 'resolved', wallet: ownerWallet, assurance: 'wallet-proven' }),
    now,
    env: { ...ARENA_ENV },
    chain: offlineSignatureChain,
  };
}

/**
 * Simulate an engine restart: everything held in memory is dropped and rebuilt from what the engine
 * keeps on disk (the kernel's JSONL ledger). The arena's own tally is in memory, so it is reset too.
 */
export function restart(w: World): void {
  const ledger = new w.engine.kernel.StoreLedger(w.engine.kernel.createJsonlStore(w.ledgerPath));
  w.deps = kernelDeps(ledger, w.owner.address, w.now);
  w.tally = { spent: {}, count: 0 };
}

export function disposeWorld(w: World): void {
  if (process.env.ARENA_KEEP !== '1') rmSync(w.dir, { recursive: true, force: true });
}

// ── building NPAs and requests ───────────────────────────────────────────────────────────────────

export interface NpaOpts {
  sym?: Sym;
  amount_raw: string;
  work?: { statement: string; criteria: string[] };
  chain_id?: number;
  quote_expires_in_s?: number;
  buyer?: Hex;
  seller?: Hex;
  asset?: Hex;
  signBuyer?: boolean;
  /** true = the real seller; 'forged' = the attacker's key; 'as-buyer' = the buyer's key; false = unsigned. */
  signSeller?: boolean | 'forged' | 'as-buyer';
}

export async function buildNpa(w: World, o: NpaOpts): Promise<SignedNpa> {
  const sym = o.sym ?? 'USDC';
  const entry = w.policy.assets.find((a) => a.symbol === sym)!;
  const work = o.work ?? { statement: `L0 arena service for ${sym}`, criteria: ['non-empty answer'] };
  const npa: Npa = {
    buyer: o.buyer ?? w.addr.buyer,
    seller: o.seller ?? w.addr.seller,
    service_hash: serviceHashOf(work.statement, work.criteria),
    chain_id: o.chain_id ?? w.policy.chain_id,
    asset: o.asset ?? assetKey(entry.contract),
    decimals: entry.decimals,
    amount_raw: o.amount_raw,
    quote_source: 'l0:fixed-amount-in-payment-asset',
    quote_expires_at: Math.floor(w.now() / 1000) + (o.quote_expires_in_s ?? 300),
    max_fee_wei: w.policy.max_fee_wei,
    settlement: 'onchain-readback',
    nonce: `0x${randomBytes(32).toString('hex')}`,
  };
  const buyerAcc = privateKeyToAccount(w.keys.buyer);
  const sellerAcc = privateKeyToAccount(o.signSeller === 'forged' ? w.keys.attacker : o.signSeller === 'as-buyer' ? w.keys.buyer : w.keys.seller);
  return {
    npa,
    buyer_sig: o.signBuyer === false ? null : await signNpa(buyerAcc, npa),
    seller_sig: o.signSeller === false ? null : await signNpa(sellerAcc, npa),
  };
}

export function requestOf(s: SignedNpa, over: Partial<Presentation['request']> = {}): Presentation['request'] {
  return { chain_id: s.npa.chain_id, asset: s.npa.asset, recipient: s.npa.seller, amount_raw: s.npa.amount_raw, payer: s.npa.buyer, ...over };
}

export const presentationOf = (s: SignedNpa, over: Partial<Presentation['request']> = {}, operation = 'pay'): Presentation => ({ operation, npa: s, request: requestOf(s, over) });

// ── the executor ─────────────────────────────────────────────────────────────────────────────────

const symOf = (w: World, asset: unknown): Sym | null => (w.policy.assets.find((a) => sameAddr(assetKey(a.contract), asset))?.symbol as Sym | undefined) ?? null;

function kernelRequest(w: World, sym: Sym, pres: Presentation, npaHash: string) {
  return {
    agent: { agent_id: w.kernelSubjects[sym], agent_name: `arena-buyer-${sym}` },
    tool: { name: 'arena.pay', class: 'spend' },
    origin: 'arena-l0',
    // The authorization's identity (spec §4). The kernel does not look at it: that is the missing hook.
    args_hash: `0x${npaHash}`,
    amount_raw: pres.request.amount_raw,
    payee: pres.request.recipient,
    asset: symOf(w, pres.request.asset) ?? pres.request.asset,
    chain_id: pres.request.chain_id,
  };
}

export const serializeReadback = (rb: TxReadback | null): Record<string, unknown> | null =>
  rb && {
    found: rb.found,
    success: rb.success ?? null,
    from: rb.from ?? null,
    to: rb.to ?? null,
    value: rb.value?.toString() ?? null,
    block: rb.block?.toString() ?? null,
    fee_wei: rb.feeWei?.toString() ?? null,
    error: rb.error ?? null,
    transfers: rb.transfers.map((t) => ({ token: t.token, from: t.from, to: t.to, amount: t.amount.toString() })),
  };

export async function present(w: World, pres: Presentation, label: string): Promise<Attempt> {
  // The presentation is untrusted and may be anything: read it defensively, the preflight refuses what is malformed.
  const npaHash = npaHashOrNull(pres?.npa?.npa) ?? '0'.repeat(64);
  const att: Attempt = { label, at: isoOf(w.now()), npa_hash: npaHash, sym: symOf(w, pres?.npa?.npa?.asset), amount_raw: String(pres?.npa?.npa?.amount_raw ?? ''), status: 'REFUSED', refusals: [], gate: null, kernel: null, kernel_dry: null, tx_hash: null, settlement_why: null, readback: null };
  w.attempts.push(att);
  const sym = symOf(w, pres?.npa?.npa?.asset);

  // 1. arena preflight
  const pf = await preflight({ policyPath: w.policyPath, pinnedPolicyId: w.pinnedPolicyId, nowS: Math.floor(w.now() / 1000), chain: w.chain, pres, tally: w.tally });
  if (pf.refusals.length > 0) {
    att.refusals = pf.refusals;
    att.kernel_dry = sym ? await dryKernel(w, sym, pres, npaHash) : { skipped: 'the NPA names an asset the policy does not list' };
    return att;
  }
  if (!sym) throw new Error('unreachable: preflight passed for an asset outside the policy');

  // 2. x402 authority gate. It is denominated in USDC, so it applies to USDC only: L0 has no ETH quote.
  if (sym === 'USDC') {
    const d = await w.engine.gate.checkTransactionAuthority({ agent: w.agents.buyer.name, transaction_type: 'a2a_payment', amount: Number(pres.request.amount_raw) / 1e6 });
    att.gate = { applicable: true, authorized: d.authorized, denial_reason: d.denial_reason, tier: d.tier, per_tx_limit: d.per_tx_limit, daily_used: d.daily_used };
    if (!d.authorized) {
      att.refusals = [{ stage: 'gate', code: d.denial_reason ?? 'gate_denied' }];
      return att;
    }
  } else {
    att.gate = { applicable: false, reason: 'the x402 gate is denominated in USDC; L0 has no ETH price, and none is invented' };
  }

  // 3. the kernel decides and, only on ALLOW, runs the tool.
  const seen: { hash?: Hex; rb?: TxReadback } = {};
  const amount = BigInt(pres.request.amount_raw);
  const tool = async () => {
    const hash = await w.chain.send({ key: w.keys.buyer, asset: pres.request.asset, to: pres.request.recipient, amount });
    w.sends.push({ hash, asset: pres.request.asset, to: pres.request.recipient, amount });
    seen.hash = hash;
    seen.rb = await w.chain.readback(hash);
    return hash;
  };
  const out = await w.engine.kernel.runUnderKernel(kernelRequest(w, sym, pres, npaHash), tool, w.deps, {
    observePayment: () => {
      const rb = seen.rb;
      const moved = rb?.transfers.reduce((s, t) => s + t.amount, 0n) || rb?.value || 0n;
      return { scheme: sym === 'ETH' ? 'native' : 'erc20-transfer', payer: pres.npa.npa.buyer, tx_hash: seen.hash ?? null, block: rb?.block !== undefined ? Number(rb.block) : null, observed_amount_raw: moved.toString(), measured: rb?.success === true };
    },
  });
  att.kernel = {
    verdict: out.verdict,
    executed: out.executed,
    persisted: out.persisted,
    reasons: out.reasons.map((r) => r.code),
    tool_error: out.tool_error ?? null,
    receipt_id: out.decision_receipt?.header.receipt_id ?? null,
    payment_status: out.final_receipt?.payment.status ?? null,
    outcome_unrecorded: out.outcome_unrecorded,
  };
  if (!out.executed) {
    att.refusals = [{ stage: 'kernel', code: out.verdict, detail: out.reasons.map((r) => r.code).join(',') }];
    return att;
  }
  att.tx_hash = seen.hash ?? null;
  att.readback = serializeReadback(seen.rb ?? null);
  if (out.tool_error) {
    att.status = 'FAILED';
    att.settlement_why = `the payment tool threw (${out.tool_error})`;
    return att;
  }

  // 4. the settlement is whatever the chain says, not whatever the tool returned.
  const c = classifySettlement(pres.npa.npa, seen.rb ?? null);
  att.status = c.status;
  att.settlement_why = c.why;
  if (c.status === 'SETTLED') {
    w.tally.spent[sym] = (w.tally.spent[sym] ?? 0n) + amount;
    w.tally.count++;
    w.settled.set(seen.hash!, { npa: pres.npa.npa, counted: false });
  }
  return att;
}

/** What the kernel alone says about a request the preflight refused. A dry decision writes and runs nothing. */
async function dryKernel(w: World, sym: Sym, pres: Presentation, npaHash: string): Promise<Attempt['kernel_dry']> {
  try {
    const r = await w.engine.kernel.dryDecision(kernelRequest(w, sym, pres, npaHash), w.deps);
    return 'malformed' in r ? { verdict: 'DENY', reasons: r.malformed.map((x) => x.code) } : { verdict: r.verdict, reasons: r.reasons.map((x) => x.code) };
  } catch (e) {
    return { skipped: `dry decision threw: ${String((e as Error).message).slice(0, 80)}` };
  }
}

/** A settlement CLAIM (a tx hash someone cites): classified from the chain, never believed. */
export async function claimSettlement(w: World, npa: Npa, hash: Hex, label: string): Promise<Attempt> {
  const rb = await w.chain.readback(hash);
  const c = classifySettlement(npa, rb);
  const att: Attempt = { label, at: isoOf(w.now()), npa_hash: npaHashOf(npa), sym: symOf(w, npa.asset), amount_raw: npa.amount_raw, status: c.status, refusals: [], gate: null, kernel: null, kernel_dry: null, tx_hash: hash, settlement_why: c.why, readback: serializeReadback(rb) };
  w.attempts.push(att);
  return att;
}

// ── RepID (the engine's real delta functions, in the LOCAL_MODE store) ───────────────────────────

export interface RepidResult {
  applied: boolean;
  reason: string;
  provider_delta: number;
  buyer_delta: number;
}

const repidOf = async (w: World, agentId: string): Promise<number> => (await w.engine.db.from('repid_agents').select('*').eq('id', agentId).single()).data.current_repid;

/**
 * RepID for one cited payment. Eligible only if the arena verified the settlement on the chain (again, now),
 * the rater is the payer of that settlement, the rater is not the provider, and the payment has not been
 * counted before. Anything else is refused here and the engine's delta function is never called.
 */
export async function awardRepid(w: World, f: { raterAgentId: string; providerAgentId: string; citedTx: Hex; accepted: boolean }): Promise<RepidResult> {
  const no = (reason: string): RepidResult => ({ applied: false, reason, provider_delta: 0, buyer_delta: 0 });
  const rec = w.settled.get(f.citedTx);
  if (!rec) return no('settlement_not_verified_by_arena');
  const c = classifySettlement(rec.npa, await w.chain.readback(f.citedTx));
  if (c.status !== 'SETTLED') return no(`settlement_not_settled_on_readback:${c.status}`);
  if (f.raterAgentId === f.providerAgentId) return no('rater_is_provider');
  if (f.raterAgentId !== w.agents.buyer.id) return no('rater_is_not_the_payer');
  if (rec.counted) return no('feedback_already_counted');
  if (!f.accepted) return no('deliverable_not_accepted');
  rec.counted = true;

  const settlementId = randomUUID();
  const contractId = randomUUID();
  await w.engine.db.from('x402_settlements').insert({ id: settlementId, tx_hash: f.citedTx, chain_id: w.policy.chain_id, amount_raw: rec.npa.amount_raw, payer: rec.npa.buyer, payee: rec.npa.seller, is_simulated: false });
  await w.engine.db.from('service_contracts').insert({ id: contractId, provider_agent_id: f.providerAgentId, buyer_agent_id: f.raterAgentId, x402_payment_id: settlementId, metadata: {}, payload: {} });
  const [p0, b0] = [await repidOf(w, f.providerAgentId), await repidOf(w, f.raterAgentId)];
  await w.engine.delta.applyServiceSatisfiedDeltas({ id: contractId, provider_agent_id: f.providerAgentId, buyer_agent_id: f.raterAgentId }, 1);
  return { applied: true, reason: 'eligible', provider_delta: (await repidOf(w, f.providerAgentId)) - p0, buyer_delta: (await repidOf(w, f.raterAgentId)) - b0 };
}

/**
 * PROBE, not a gate: what the engine's own delta function does with a self-contract (provider == buyer,
 * non-simulated settlement) when nothing in front of it refuses. Run on a scratch agent so no world agent moves.
 */
export async function probeEngineSelfRating(w: World): Promise<{ provider_delta: number }> {
  const id = randomUUID();
  await w.engine.db.from('repid_agents').insert({ id, agent_name: `arena-probe-${id.slice(0, 8)}`, current_repid: 500, tier: 'PROBATIONARY', activity_30d: 10, constitution: {}, wallet_address: w.addr.attacker, erc8004_token_id: null });
  const settlementId = randomUUID();
  const contractId = randomUUID();
  await w.engine.db.from('x402_settlements').insert({ id: settlementId, tx_hash: `0x${randomBytes(32).toString('hex')}`, chain_id: w.policy.chain_id, amount_raw: '1', payer: w.addr.attacker, payee: w.addr.attacker, is_simulated: false });
  await w.engine.db.from('service_contracts').insert({ id: contractId, provider_agent_id: id, buyer_agent_id: id, x402_payment_id: settlementId, metadata: {}, payload: {} });
  const before = await repidOf(w, id);
  await w.engine.delta.applyServiceSatisfiedDeltas({ id: contractId, provider_agent_id: id, buyer_agent_id: id }, 1);
  return { provider_delta: (await repidOf(w, id)) - before };
}

