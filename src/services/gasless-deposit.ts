/**
 * GASLESS OWNER DEPOSIT (EIP-3009), R3 2026-11-16. Flag GASLESS_DEPOSIT_MODE: off (default) | shadow | on.
 *
 * WHY. A newcomer has testnet USDC and no ETH, and a plain ERC-20 transfer needs gas. The owner
 * instead SIGNS a USDC `transferWithAuthorization` (from = their wallet, to = the stake escrow) in
 * their wallet: a signature, no transaction, no gas. The engine checks it, the escrow submits it and
 * pays the gas, and the stake is credited (ONBOARDING_FRICTION_LOG stop 4).
 *
 * NOTHING HERE IS A SECOND VERIFIER. The signature, time window and recipient are checked by
 * verifyEip3009Local (x402-resilient.ts, the x402 path), against USDC's name and version read from
 * the chain and matched to its DOMAIN_SEPARATOR (resolveAndVerifyDomain). The send is the escrow's
 * guarded path (escrow-refunder.ts escrowRelayAuthorization). The credit is depositStake's verified
 * path (stake-vault.ts): the same on-chain Transfer check, exact-amount rule and one-credit-per-tx
 * rule every real deposit gets. What this file adds is the order, and the refusals that must come
 * BEFORE the escrow spends gas:
 *   - the authorization must pay the escrow, exactly, for a positive amount;
 *   - it must not expire within MIN_WINDOW_S (it would revert after the escrow paid gas);
 *   - the payer must have an account here, or the USDC would arrive with nobody to credit;
 *   - the nonce must be unused on chain (replay), and the payer must hold the amount.
 *
 * MODES. off: refused, nothing read or sent. shadow: every check runs and the answer says what WOULD
 * be submitted; nothing is sent. on: submitted, then credited. Any other value is off (a typo in a
 * money control sends nothing).
 */
import { ethers } from 'ethers';
import { config } from '../config';
import { db } from '../db';
import { verifyEip3009Local } from './x402-resilient';
import { resolveAndVerifyDomain } from './x402-outbound-client';
import { escrowRelayAuthorization, RefundBroadcastUnconfirmed, type Eip3009Authorization } from './escrow-refunder';
import { depositStake, serializeWithdraw, type DepositResult } from './stake-vault';
import { BASE_SEPOLIA_CHAIN_ID } from './testnet-only';
import { BASESCAN_TX, USDC_BASE_SEPOLIA } from './agent-spend';

export type GaslessMode = 'off' | 'shadow' | 'on';

export function gaslessDepositMode(raw: string | undefined = process.env.GASLESS_DEPOSIT_MODE): GaslessMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'shadow' || v === 'on') return v;
  if (v !== '' && v !== 'off') console.error(`[gasless-deposit] GASLESS_DEPOSIT_MODE=${JSON.stringify(raw)} is not off, shadow or on: off (fail closed).`);
  return 'off';
}

/** An authorization must stay valid at least this long, so it cannot expire while the escrow's tx mines. */
export const MIN_WINDOW_S = 120;

/**
 * Smallest gasless deposit, in micro-USDC. Every accepted authorization makes the escrow sign,
 * broadcast and confirm a transaction whose gas it pays, on a keyless route where the caller picks
 * the amount, so dust is refused before anything is sent (Strix on #1558). 1 USDC is the E2E's own
 * stake and far above the L2 gas it triggers.
 */
export const MIN_GASLESS_DEPOSIT = 1_000_000n;

/**
 * Admission budget for the escrow's send queue from this keyless route. The escrow sends one
 * transaction at a time (escrow-refunder.ts oneAtATime), refunds and agent payouts queue on the same
 * chain, and each send holds it until mined; the per-authorization lock below never makes two
 * DIFFERENT authorizations wait. Without a budget a caller could queue more sends than one signer
 * drains and push every withdrawal and payout behind them (Strix on #1558). Process-wide on purpose:
 * a per-address budget is bypassed by rotating addresses. A refused deposit is retried by the client.
 */
export function createGaslessAdmission(maxPerMinute = 4, maxPerPayer = 1): (nowMs: number, payer: string) => boolean {
  const recent: Array<{ at: number; payer: string }> = [];
  return (nowMs, payer) => {
    while (recent.length > 0 && nowMs - recent[0]!.at >= 60_000) recent.shift();
    if (recent.length >= maxPerMinute) return false;
    // A per-payer bound ON TOP of the global one (Strix on #1558): one wallet can no longer spend the
    // whole minute's budget on concurrent deposits the escrow then refuses. Rotating wallets still
    // meets the global cap, and each wallet needs an account here and the USDC it signs for.
    const key = payer.toLowerCase();
    if (recent.filter((r) => r.payer === key).length >= maxPerPayer) return false;
    recent.push({ at: nowMs, payer: key });
    return true;
  };
}

export interface GaslessChain {
  authorizationState(authorizer: string, nonce: string): Promise<boolean>;
  balanceOf(owner: string): Promise<bigint>;
  usdcDomain(): Promise<{ name: string; version: string }>;
}

export interface GaslessDeps {
  mode: GaslessMode;
  escrow: string | null;
  usdc: string;
  realStaking: boolean;
  chain: GaslessChain;
  accountOf(wallet: string): Promise<string | null>;
  relay(a: Eip3009Authorization, signature: string): Promise<{ txHash: string }>;
  credit(wallet: string, amount: bigint, txHash: string): Promise<DepositResult>;
  now(): number;
  /** Admission to the escrow's send queue; see createGaslessAdmission. */
  admit(nowMs: number, payer: string): boolean;
}

export interface GaslessAnswer {
  status: number;
  body: Record<string, unknown>;
}

const UINT = /^(0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIG = /^0x[0-9a-fA-F]{130}$/;

/**
 * A chain, DB or relay error goes to the server log, never into an answer (Strix on #1559 found the
 * class): ethers puts the request URL in its messages, and a provider URL can carry an API key.
 */
function logOnly(where: string, e: unknown): void {
  console.error(`[gasless-deposit] ${where}:`, (e as Error)?.message ?? String(e));
}

function parseAuthorization(raw: unknown): Eip3009Authorization | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  const str = (k: string) => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
  const out = { from: str('from'), to: str('to'), value: str('value'), validAfter: str('validAfter'), validBefore: str('validBefore'), nonce: str('nonce') };
  if (!ethers.isAddress(out.from) || !ethers.isAddress(out.to)) return null;
  if (![out.value, out.validAfter, out.validBefore].every((v) => UINT.test(v)) || !NONCE.test(out.nonce)) return null;
  return out;
}

export async function gaslessDeposit(body: unknown, deps: GaslessDeps): Promise<GaslessAnswer> {
  const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): GaslessAnswer => ({
    status,
    body: { ok: false, mode: deps.mode, sent: false, code, error, ...extra },
  });
  if (deps.mode === 'off') return refuse(503, 'gasless_deposit_off', 'Gasless deposits are not enabled on this server. Nothing was sent.');
  if (!deps.realStaking) return refuse(503, 'real_staking_off', 'Real staking is not enabled on this server, so a deposit could not be credited. Nothing was sent.');
  if (!deps.escrow) return refuse(503, 'escrow_not_configured', 'The stake escrow is not configured on this server. Nothing was sent.');

  const b = (body ?? {}) as { authorization?: unknown; signature?: unknown };
  const a = parseAuthorization(b.authorization);
  const signature = typeof b.signature === 'string' ? b.signature : '';
  if (!a || !SIG.test(signature)) {
    return refuse(400, 'bad_authorization', 'Send { authorization: { from, to, value, validAfter, validBefore, nonce }, signature } for a USDC transferWithAuthorization. Nothing was sent.');
  }
  const value = BigInt(a.value);
  if (value < MIN_GASLESS_DEPOSIT) {
    return refuse(400, 'bad_amount', `The amount must be at least ${MIN_GASLESS_DEPOSIT} micro-USDC (1 USDC). Nothing was sent.`);
  }
  if (a.to.toLowerCase() !== deps.escrow.toLowerCase()) {
    return refuse(400, 'wrong_recipient', `The authorization must pay the stake escrow ${ethers.getAddress(deps.escrow)}. Nothing was sent.`);
  }
  const now = deps.now();
  if (BigInt(a.validBefore) <= BigInt(now)) return refuse(400, 'expired', 'This authorization has expired. Sign a new one. Nothing was sent.');
  if (BigInt(a.validBefore) < BigInt(now + MIN_WINDOW_S)) {
    return refuse(400, 'expires_too_soon', `This authorization expires in under ${MIN_WINDOW_S} s, so it could expire before it is mined. Sign one valid for longer. Nothing was sent.`);
  }

  let domain: { name: string; version: string };
  try {
    domain = await deps.chain.usdcDomain();
  } catch (e: unknown) {
    logOnly('usdc domain read', e);
    return refuse(503, 'not_checked', "Could not read USDC's signing domain from the chain, so the signature was not checked. Nothing was sent.");
  }
  // verifyEip3009Local takes an x402 payment header (base64 JSON) and requirements; reuse it as is.
  const header = Buffer.from(JSON.stringify({ authorization: a, signature })).toString('base64');
  const checked = await verifyEip3009Local(header, {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: value.toString(),
    asset: deps.usdc,
    payTo: deps.escrow,
    resource: 'stake-deposit',
    mimeType: 'application/json',
    maxTimeoutSeconds: 0,
    extra: domain,
  });
  if (!checked.valid) return refuse(400, 'bad_signature', `The authorization did not verify: ${checked.reason}. Nothing was sent.`);

  let account: string | null;
  try {
    account = await deps.accountOf(a.from);
  } catch (e: unknown) {
    logOnly('account lookup', e);
    return refuse(503, 'not_checked', 'Could not read whether this wallet has an account. Nothing was sent.');
  }
  if (!account) {
    return refuse(404, 'no_account', 'This wallet has no account here, so the deposit would have nobody to credit. Connect the wallet first (POST /api/v1/account/connect). Nothing was sent.');
  }

  let used: boolean;
  let balance: bigint;
  try {
    [used, balance] = await Promise.all([deps.chain.authorizationState(a.from, a.nonce), deps.chain.balanceOf(a.from)]);
  } catch (e: unknown) {
    logOnly('authorization state / balance read', e);
    return refuse(503, 'not_checked', "Could not read the authorization's state from the chain. Nothing was sent.");
  }
  if (used) return refuse(409, 'authorization_used', 'This authorization (its nonce) has already been used on chain. Nothing was sent again.');
  if (balance < value) return refuse(400, 'insufficient_balance', 'The wallet holds less USDC than this authorization moves. Nothing was sent.');

  const plan = { from: ethers.getAddress(a.from), to: ethers.getAddress(a.to), amount_micro_usdc: value.toString(), account_id: account, gas_paid_by: 'escrow' };
  if (deps.mode === 'shadow') {
    return { status: 200, body: { ok: true, mode: 'shadow', sent: false, would_submit: true, ...plan, note: 'Shadow mode: every check passed and nothing was sent.' } };
  }

  // One submission per authorization at a time in this process; the chain refuses a second use anyway.
  return serializeWithdraw(`gasless:${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`, async (): Promise<GaslessAnswer> => {
    try {
      if (await deps.chain.authorizationState(a.from, a.nonce)) {
        return refuse(409, 'authorization_used', 'This authorization (its nonce) has already been used on chain. Nothing was sent again.');
      }
    } catch (e: unknown) {
      logOnly('authorization state re-read', e);
      return refuse(503, 'not_checked', "Could not re-read the authorization's state. Nothing was sent.");
    }
    // Admission AFTER every refusal, the in-lock re-check included, so a refused deposit never takes a
    // slot (Grok r3 on #1558). The escrow's send queue is shared with refunds and payouts.
    if (!deps.admit(now * 1000, a.from)) {
      return refuse(429, 'escrow_busy', 'Too many gasless deposits are being submitted right now, so this one was not queued. Nothing was sent; retry in a minute.');
    }
    let txHash: string;
    try {
      ({ txHash } = await deps.relay(a, signature));
    } catch (e: unknown) {
      if (e instanceof RefundBroadcastUnconfirmed) {
        return {
          status: 202,
          body: { ok: false, mode: 'on', sent: 'unknown', code: 'sent_unconfirmed', tx_hash: e.txHash, basescan_url: `${BASESCAN_TX}${e.txHash}`, ...plan,
            error: 'The escrow broadcast the deposit but could not confirm it. Check the tx; once it is mined, claim it with POST /api/v1/stake/deposit and this tx_hash.' },
        };
      }
      logOnly('relay', e);
      return refuse(502, 'not_sent', 'The escrow did not submit the deposit, so no USDC moved.');
    }
    // The USDC has moved. From here every answer carries the tx hash: a credit that throws is not
    // "not sent", and a 500 without the hash would leave the owner nothing to claim with.
    let credited: DepositResult;
    try {
      credited = await deps.credit(a.from, value, txHash);
    } catch (e: unknown) {
      logOnly(`credit of ${txHash}`, e);
      return {
        status: 202,
        body: { ok: false, mode: 'on', sent: true, code: 'credit_not_checked', tx_hash: txHash, basescan_url: `${BASESCAN_TX}${txHash}`, ...plan,
          error: 'The USDC reached the escrow, and the credit could not be confirmed. Claim it with POST /api/v1/stake/deposit and this tx_hash; a transfer already credited is refused as a duplicate, never credited twice.' },
      };
    }
    if (!credited.ok) {
      // depositStake's error can carry verifyDeposit's raw RPC text, so it is logged, not returned.
      console.error(`[gasless-deposit] credit of ${txHash} refused:`, credited.error ?? 'unknown');
      return {
        status: 202,
        body: { ok: false, mode: 'on', sent: true, code: 'sent_not_credited', tx_hash: txHash, basescan_url: `${BASESCAN_TX}${txHash}`, ...plan,
          error: 'The USDC reached the escrow, and the credit did not go through (for example, not enough confirmations yet). Claim it with POST /api/v1/stake/deposit and this tx_hash.' },
      };
    }
    return {
      status: 201,
      body: { ok: true, mode: 'on', sent: true, tx_hash: txHash, basescan_url: `${BASESCAN_TX}${txHash}`, ...plan, total_active_stake: credited.total_active_stake },
    };
  });
}

const AUTH_STATE_ABI = [
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
];

/** The live chain reads, Base Sepolia only. */
export function rpcGaslessChain(rpcUrl: string = config.baseSepoliaRpc, usdc: string = config.usdcTokenAddress): GaslessChain {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const token = new ethers.Contract(usdc, AUTH_STATE_ABI, provider);
  const onBaseSepolia = async () => {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`chain ${net.chainId} is not Base Sepolia`);
  };
  return {
    async authorizationState(authorizer, nonce) {
      await onBaseSepolia();
      return (await token.getFunction('authorizationState')(authorizer, nonce)) as boolean;
    },
    async balanceOf(owner) {
      await onBaseSepolia();
      return (await token.getFunction('balanceOf')(owner)) as bigint;
    },
    async usdcDomain() {
      await onBaseSepolia();
      const d = await resolveAndVerifyDomain(usdc, BASE_SEPOLIA_CHAIN_ID, provider);
      return { name: d.name, version: d.version };
    },
  };
}

async function accountOfWallet(wallet: string): Promise<string | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return null;
  const { data, error } = await db.from('builders').select('id').ilike('address', wallet).limit(2);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length > 1) throw new Error('more than one account matches this wallet');
  return rows[0] ? String(rows[0].id) : null;
}

let chainSingleton: GaslessChain | null = null;
const admission = createGaslessAdmission();

/** Production wiring. */
export function defaultGaslessDeps(): GaslessDeps {
  const { configuredEscrowAddress } = require('./escrow-refunder') as typeof import('./escrow-refunder');
  return {
    mode: gaslessDepositMode(),
    escrow: configuredEscrowAddress(),
    usdc: config.usdcTokenAddress || USDC_BASE_SEPOLIA,
    realStaking: config.realStakingEnabled,
    chain: (chainSingleton ??= rpcGaslessChain()),
    accountOf: accountOfWallet,
    relay: escrowRelayAuthorization,
    credit: depositStake,
    now: () => Math.floor(Date.now() / 1000),
    admit: admission,
  };
}
