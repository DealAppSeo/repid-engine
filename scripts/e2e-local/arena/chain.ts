/**
 * L0 arena chain access. One interface, two implementations:
 *   - ViemChain   a Hardhat devnet over JSON-RPC (chainId 31337). The real thing: the loop and the
 *                 devnet suite use it. Parties sign their own transactions with their own keys;
 *                 the devnet's unlocked accounts are used only as a faucet and to deploy the mock token.
 *   - MemoryChain an in-process twin with the same observable behaviour (balances, nonces, receipts,
 *                 Transfer logs, reverts, fees) so the offline jest suite runs without a node.
 *
 * The executor never reads a chain through anything but this interface, so "read the chain back"
 * means the same code path on both.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEventLogs, type Abi, type Hex } from 'viem';
import { privateKeyToAddress, privateKeyToAccount } from 'viem/accounts';
import { ZERO_ADDRESS, sameAddr, type TxReadback } from './core';

const TOKEN = JSON.parse(readFileSync(join(__dirname, 'contracts', 'MockUSDC.json'), 'utf8')) as { abi: Abi; bytecode: Hex };
const isNative = (a: Hex): boolean => sameAddr(a, ZERO_ADDRESS);

export interface ChainPort {
  readonly kind: 'memory' | 'devnet';
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** symbol()/decimals() as the contract itself answers; null when it is not an ERC-20 at that address. */
  tokenInfo(token: Hex): Promise<{ symbol: string; decimals: number } | null>;
  /** `asset` is the token contract, or the zero address for the native asset. */
  balance(asset: Hex, who: Hex): Promise<bigint>;
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint>;
  /** The account nonce: how many transactions this address has sent. */
  txCount(who: Hex): Promise<number>;
  /** Sign with `key`, send, wait for inclusion, return the hash. A send that cannot even be simulated throws. */
  send(p: { key: Hex; asset: Hex; to: Hex; amount: bigint }): Promise<Hex>;
  readback(hash: Hex): Promise<TxReadback>;
}

/** Setup-only powers the arena needs on a throwaway chain. Never handed to an agent. */
export interface TestChain extends ChainPort {
  fundNative(to: Hex, wei: bigint): Promise<Hex>;
  deployToken(name: string, symbol: string): Promise<Hex>;
  mint(token: Hex, to: Hex, amount: bigint): Promise<void>;
}

// ── devnet ───────────────────────────────────────────────────────────────────────────────────────

export class ViemChain implements TestChain {
  readonly kind = 'devnet' as const;
  private readonly chain;
  private readonly pub;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly rpc: string, id = 31337) {
    this.chain = defineChain({ id, name: 'hardhat-local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    this.pub = createPublicClient({ chain: this.chain, transport: http(rpc), pollingInterval: 20 });
  }

  private wallet(account: Hex | ReturnType<typeof privateKeyToAccount>) {
    return createWalletClient({ chain: this.chain, transport: http(this.rpc), account: account as never });
  }

  /** One in-flight transaction per sender: concurrent callers would otherwise race for the same nonce. */
  private serial<T>(who: string, fn: () => Promise<T>): Promise<T> {
    const k = who.toLowerCase();
    const run = (this.locks.get(k) ?? Promise.resolve()).then(fn, fn);
    this.locks.set(k, run.catch(() => undefined));
    return run;
  }

  private async faucetAccount(): Promise<Hex> {
    const accounts = await createWalletClient({ chain: this.chain, transport: http(this.rpc) }).getAddresses();
    if (!accounts[0]) throw new Error('the devnet has no unlocked account to use as a faucet');
    return getAddress(accounts[0]) as Hex;
  }

  chainId = () => this.pub.getChainId();
  blockNumber = () => this.pub.getBlockNumber();

  async tokenInfo(token: Hex) {
    try {
      const [symbol, decimals] = await Promise.all([
        this.pub.readContract({ address: token, abi: TOKEN.abi, functionName: 'symbol' }),
        this.pub.readContract({ address: token, abi: TOKEN.abi, functionName: 'decimals' }),
      ]);
      return typeof symbol === 'string' && Number.isInteger(Number(decimals)) ? { symbol, decimals: Number(decimals) } : null;
    } catch {
      return null;
    }
  }

  async balance(asset: Hex, who: Hex) {
    if (isNative(asset)) return this.pub.getBalance({ address: who });
    return (await this.pub.readContract({ address: asset, abi: TOKEN.abi, functionName: 'balanceOf', args: [who] })) as bigint;
  }

  async allowance(token: Hex, owner: Hex, spender: Hex) {
    return (await this.pub.readContract({ address: token, abi: TOKEN.abi, functionName: 'allowance', args: [owner, spender] })) as bigint;
  }

  txCount = (who: Hex) => this.pub.getTransactionCount({ address: who });

  async send(p: { key: Hex; asset: Hex; to: Hex; amount: bigint }): Promise<Hex> {
    const account = privateKeyToAccount(p.key);
    return this.serial(account.address, async () => {
      const w = this.wallet(account);
      const hash = isNative(p.asset)
        ? await w.sendTransaction({ to: p.to, value: p.amount })
        : await w.writeContract({ address: p.asset, abi: TOKEN.abi, functionName: 'transfer', args: [p.to, p.amount] });
      await this.pub.waitForTransactionReceipt({ hash });
      return hash;
    });
  }

  async readback(hash: Hex): Promise<TxReadback> {
    try {
      const tx = await this.pub.getTransaction({ hash }).catch(() => null);
      if (!tx) return { found: false, transfers: [] };
      const rc = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (!rc) return { found: true, from: tx.from, to: tx.to, value: tx.value, transfers: [] };
      const logs = parseEventLogs({ abi: TOKEN.abi, logs: rc.logs, eventName: 'Transfer' }) as unknown as Array<{ address: Hex; args: { from: Hex; to: Hex; value: bigint } }>;
      return {
        found: true,
        success: rc.status === 'success',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        block: rc.blockNumber,
        feeWei: rc.gasUsed * rc.effectiveGasPrice,
        transfers: logs.map((l) => ({ token: l.address, from: l.args.from, to: l.args.to, amount: l.args.value })),
      };
    } catch (e) {
      return { found: false, transfers: [], error: String((e as Error).message ?? e).slice(0, 160) };
    }
  }

  async fundNative(to: Hex, wei: bigint) {
    const hash = await this.wallet(await this.faucetAccount()).sendTransaction({ to, value: wei });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  async deployToken(name: string, symbol: string) {
    const hash = await this.wallet(await this.faucetAccount()).deployContract({ abi: TOKEN.abi, bytecode: TOKEN.bytecode, args: [name, symbol] });
    const rc = await this.pub.waitForTransactionReceipt({ hash });
    return getAddress(rc.contractAddress!) as Hex;
  }

  async mint(token: Hex, to: Hex, amount: bigint) {
    const hash = await this.wallet(await this.faucetAccount()).writeContract({ address: token, abi: TOKEN.abi, functionName: 'mint', args: [to, amount] });
    await this.pub.waitForTransactionReceipt({ hash });
  }
}

// ── in-memory twin ───────────────────────────────────────────────────────────────────────────────

const FEE_NATIVE = 21_000n * 1_000_000_000n;
const FEE_TOKEN = 52_000n * 1_000_000_000n;
const FAUCET = '0x00000000000000000000000000000000000fa0ce' as Hex;

interface MemTx {
  from: Hex;
  to: Hex;
  value: bigint;
  block: bigint;
  fee: bigint;
  transfers: TxReadback['transfers'];
}

export class MemoryChain implements TestChain {
  readonly kind = 'memory' as const;
  private readonly bal = new Map<string, bigint>();
  private readonly nonces = new Map<string, number>();
  private readonly txs = new Map<string, MemTx>();
  private readonly tokens = new Map<string, { symbol: string; decimals: number }>();
  private block = 1n;
  private seq = 0;

  constructor(private readonly id = 31337) {}

  private key = (asset: Hex, who: Hex) => `${asset.toLowerCase()}:${who.toLowerCase()}`;
  private get = (asset: Hex, who: Hex) => this.bal.get(this.key(asset, who)) ?? 0n;
  private add = (asset: Hex, who: Hex, d: bigint) => this.bal.set(this.key(asset, who), this.get(asset, who) + d);
  private hash(parts: unknown[]): Hex {
    return `0x${createHash('sha256').update(`${this.seq++}:${parts.join(':')}`).digest('hex')}`;
  }

  async chainId() {
    return this.id;
  }
  async blockNumber() {
    return this.block;
  }
  async tokenInfo(token: Hex) {
    return this.tokens.get(token.toLowerCase()) ?? null;
  }
  async balance(asset: Hex, who: Hex) {
    return this.get(asset, who);
  }
  async allowance() {
    return 0n; // the mock chain has no approve path at all; the executor never builds one
  }
  async txCount(who: Hex) {
    return this.nonces.get(who.toLowerCase()) ?? 0;
  }

  async send(p: { key: Hex; asset: Hex; to: Hex; amount: bigint }): Promise<Hex> {
    const from = getAddress(privateKeyToAddress(p.key)) as Hex;
    const native = isNative(p.asset);
    const fee = native ? FEE_NATIVE : FEE_TOKEN;
    if (native ? this.get(ZERO_ADDRESS, from) < p.amount + fee : this.get(ZERO_ADDRESS, from) < fee || this.get(p.asset, from) < p.amount) {
      throw new Error('execution reverted: insufficient balance');
    }
    this.block += 1n;
    this.nonces.set(from.toLowerCase(), (this.nonces.get(from.toLowerCase()) ?? 0) + 1);
    this.add(ZERO_ADDRESS, from, -fee);
    this.add(p.asset, from, -p.amount);
    this.add(p.asset, p.to, p.amount);
    const hash = this.hash([from, p.asset, p.to, p.amount]);
    this.txs.set(hash, {
      from,
      to: native ? p.to : p.asset,
      value: native ? p.amount : 0n,
      block: this.block,
      fee,
      transfers: native ? [] : [{ token: p.asset, from, to: p.to, amount: p.amount }],
    });
    return hash;
  }

  async readback(hash: Hex): Promise<TxReadback> {
    const t = this.txs.get(hash);
    if (!t) return { found: false, transfers: [] };
    return { found: true, success: true, from: t.from, to: t.to, value: t.value, block: t.block, feeWei: t.fee, transfers: t.transfers };
  }

  async fundNative(to: Hex, wei: bigint) {
    this.block += 1n;
    this.add(ZERO_ADDRESS, to, wei);
    const hash = this.hash([FAUCET, to, wei]);
    this.txs.set(hash, { from: FAUCET, to, value: wei, block: this.block, fee: 0n, transfers: [] });
    return hash;
  }

  async deployToken(name: string, symbol: string) {
    void name;
    const addr = getAddress(`0x${createHash('sha256').update(`token:${this.seq++}:${symbol}`).digest('hex').slice(0, 40)}`) as Hex;
    this.tokens.set(addr.toLowerCase(), { symbol, decimals: 6 });
    return addr;
  }

  async mint(token: Hex, to: Hex, amount: bigint) {
    this.add(token, to, amount);
  }
}
