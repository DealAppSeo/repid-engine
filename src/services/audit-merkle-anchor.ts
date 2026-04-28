/**
 * Daily Merkle anchoring for hal_audit_chain.
 *
 * The audit chain is HMAC-chained off-chain. Anyone with database
 * write access could (in principle) splice a fake row in at the tail
 * if they recomputed previous_entry_hash. Anchoring a daily Merkle
 * root on Base Sepolia in a 0-ETH self-transfer's calldata makes the
 * chain provably tamper-evident: post-anchor mutations would force
 * the recomputed root to diverge from the on-chain commitment.
 *
 * computeDailyMerkleRoot(date)
 *   - reads all hal_audit_chain rows where created_at::date = date
 *   - leaf  = keccak256(id || canonical(event_payload) || prev_hash)
 *   - node  = keccak256(left || right) (Bitcoin-style: odd → duplicate)
 *   - returns { root, entry_count, first_id, last_id }
 *
 * anchorDailyRoot(date)
 *   - calls computeDailyMerkleRoot
 *   - if entry_count > 0: signs and sends a self-transfer of 0 ETH on
 *     Base Sepolia with root bytes in data field
 *   - persists to audit_merkle_anchors (date is unique key — re-runs
 *     for the same date are upserts)
 *   - 30s timeout, single retry, never throws — degraded path returns
 *     status: 'pending_retry' or 'no_entries' as appropriate
 *
 * Wallet: AUDIT_ANCHOR_PRIVATE_KEY if set, else falls back to
 * DEPLOYER_PRIVATE_KEY (the existing TRINITY_DEPLOYER). RPC endpoint:
 * BASE_SEPOLIA_RPC_URL or the public default.
 *
 * Gas estimate: ~21k for self-transfer + 16 gas/byte calldata × 32
 * bytes root = ~21,512 gas. At 0.01 gwei × 21512 ≈ ~$0.0001/anchor.
 */

import { keccak256, hexlify, toUtf8Bytes, getBytes, concat, ZeroHash, JsonRpcProvider, Wallet } from 'ethers';
import { db } from '../db';
import { canonicalJson } from './auditChainWriter';

const BASE_SEPOLIA_RPC_DEFAULT = 'https://sepolia.base.org';
const TX_TIMEOUT_MS = 30_000;

export type AnchorStatus =
  | 'sent'
  | 'no_entries'
  | 'pending_retry'
  | 'failed_persist'
  | 'failed_no_wallet';

export interface MerkleRootResult {
  root: string;
  entry_count: number;
  first_id: number | null;
  last_id: number | null;
}

export interface AnchorResult {
  status: AnchorStatus;
  date: string;
  root: string;
  entry_count: number;
  first_id: number | null;
  last_id: number | null;
  tx_hash: string | null;
  basescan_url: string | null;
  error?: string;
}

interface AuditRow {
  id: number;
  event_payload: Record<string, unknown>;
  previous_entry_hash: string | null;
}

/* -------------------------------------------------------------------------- */
/* Hashing primitives                                                          */
/* -------------------------------------------------------------------------- */

function leafHash(row: AuditRow): string {
  const idBytes = toUtf8Bytes(String(row.id));
  const payloadBytes = toUtf8Bytes(canonicalJson(row.event_payload));
  const prevBytes = toUtf8Bytes(row.previous_entry_hash ?? '');
  return keccak256(concat([idBytes, payloadBytes, prevBytes]));
}

function pairHash(a: string, b: string): string {
  return keccak256(concat([getBytes(a), getBytes(b)]));
}

/**
 * Bitcoin-style Merkle tree: pair-hash adjacent leaves, duplicate the
 * last when the level has odd count. Recurse until a single root
 * remains. Empty input → ZeroHash.
 */
export function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ZeroHash;
  if (leaves.length === 1) return leaves[0]!;

  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // odd → duplicate
      next.push(pairHash(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/* -------------------------------------------------------------------------- */
/* Compute root for a date                                                     */
/* -------------------------------------------------------------------------- */

function dateBoundsUtc(date: Date): { start: string; end: string; isoDate: string } {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const start = `${y}-${m}-${d}T00:00:00.000Z`;
  // Exclusive upper bound: next day at 00:00 UTC.
  const next = new Date(Date.UTC(y, date.getUTCMonth(), date.getUTCDate() + 1));
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const nd = String(next.getUTCDate()).padStart(2, '0');
  const end = `${ny}-${nm}-${nd}T00:00:00.000Z`;
  return { start, end, isoDate: `${y}-${m}-${d}` };
}

export async function computeDailyMerkleRoot(date: Date): Promise<MerkleRootResult> {
  const { start, end } = dateBoundsUtc(date);
  const { data, error } = await db
    .from('hal_audit_chain')
    .select('id, event_payload, previous_entry_hash')
    .gte('created_at', start)
    .lt('created_at', end)
    .order('id', { ascending: true });

  if (error) throw new Error(`[audit-merkle] query failed: ${error.message}`);

  const rows: AuditRow[] = (data ?? []) as AuditRow[];
  if (rows.length === 0) {
    return { root: ZeroHash, entry_count: 0, first_id: null, last_id: null };
  }

  const leaves = rows.map(leafHash);
  const root = buildMerkleRoot(leaves);
  return {
    root,
    entry_count: rows.length,
    first_id: rows[0]!.id,
    last_id: rows[rows.length - 1]!.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Anchor on Base Sepolia                                                      */
/* -------------------------------------------------------------------------- */

function getSigningKey(): string | null {
  return (process.env.AUDIT_ANCHOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || '').trim() || null;
}

function getRpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA_RPC_DEFAULT;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let to: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    to = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (to) clearTimeout(to);
  }
}

interface SendAnchorTxArgs {
  root: string;
  privateKey: string;
  rpcUrl: string;
}
interface SendAnchorTxResult {
  tx_hash: string;
}

export async function sendAnchorTx(args: SendAnchorTxArgs): Promise<SendAnchorTxResult> {
  const provider = new JsonRpcProvider(args.rpcUrl);
  const wallet = new Wallet(args.privateKey, provider);
  const data = hexlify(getBytes(args.root)); // 0x + 32 bytes
  const tx = await wallet.sendTransaction({
    to: wallet.address,
    value: 0n,
    data,
  });
  return { tx_hash: tx.hash };
}

async function persistAnchor(input: {
  isoDate: string;
  root: string;
  entry_count: number;
  first_id: number | null;
  last_id: number | null;
  tx_hash: string | null;
  basescan_url: string | null;
  status: AnchorStatus;
}): Promise<{ ok: boolean; error?: string }> {
  const row = {
    anchor_date: input.isoDate,
    merkle_root: input.root,
    entry_count: input.entry_count,
    first_audit_id: input.first_id,
    last_audit_id: input.last_id,
    tx_hash: input.tx_hash,
    basescan_url: input.basescan_url,
    status: input.status,
  };
  const { error } = await db
    .from('audit_merkle_anchors')
    .upsert(row, { onConflict: 'anchor_date' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function anchorDailyRoot(date: Date): Promise<AnchorResult> {
  const { isoDate } = dateBoundsUtc(date);

  let merkle: MerkleRootResult;
  try {
    merkle = await computeDailyMerkleRoot(date);
  } catch (e: any) {
    return {
      status: 'pending_retry',
      date: isoDate,
      root: ZeroHash,
      entry_count: 0,
      first_id: null,
      last_id: null,
      tx_hash: null,
      basescan_url: null,
      error: e?.message ?? 'compute failed',
    };
  }

  if (merkle.entry_count === 0) {
    const persist = await persistAnchor({
      isoDate,
      root: merkle.root,
      entry_count: 0,
      first_id: null,
      last_id: null,
      tx_hash: null,
      basescan_url: null,
      status: 'no_entries',
    });
    return {
      status: persist.ok ? 'no_entries' : 'failed_persist',
      date: isoDate,
      root: merkle.root,
      entry_count: 0,
      first_id: null,
      last_id: null,
      tx_hash: null,
      basescan_url: null,
      ...(persist.ok ? {} : { error: persist.error }),
    };
  }

  const key = getSigningKey();
  if (!key) {
    await persistAnchor({
      isoDate,
      root: merkle.root,
      entry_count: merkle.entry_count,
      first_id: merkle.first_id,
      last_id: merkle.last_id,
      tx_hash: null,
      basescan_url: null,
      status: 'failed_no_wallet',
    });
    return {
      status: 'failed_no_wallet',
      date: isoDate,
      root: merkle.root,
      entry_count: merkle.entry_count,
      first_id: merkle.first_id,
      last_id: merkle.last_id,
      tx_hash: null,
      basescan_url: null,
      error: 'AUDIT_ANCHOR_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY not set',
    };
  }

  const rpcUrl = getRpcUrl();
  let txHash: string | null = null;
  let txError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await withTimeout(sendAnchorTx({ root: merkle.root, privateKey: key, rpcUrl }), TX_TIMEOUT_MS);
      txHash = r.tx_hash;
      break;
    } catch (e: any) {
      txError = e?.message ?? String(e);
      if (attempt === 1) break;
    }
  }

  if (!txHash) {
    await persistAnchor({
      isoDate,
      root: merkle.root,
      entry_count: merkle.entry_count,
      first_id: merkle.first_id,
      last_id: merkle.last_id,
      tx_hash: null,
      basescan_url: null,
      status: 'pending_retry',
    });
    return {
      status: 'pending_retry',
      date: isoDate,
      root: merkle.root,
      entry_count: merkle.entry_count,
      first_id: merkle.first_id,
      last_id: merkle.last_id,
      tx_hash: null,
      basescan_url: null,
      error: txError ?? 'tx send failed',
    };
  }

  const basescanUrl = `https://sepolia.basescan.org/tx/${txHash}`;
  const persist = await persistAnchor({
    isoDate,
    root: merkle.root,
    entry_count: merkle.entry_count,
    first_id: merkle.first_id,
    last_id: merkle.last_id,
    tx_hash: txHash,
    basescan_url: basescanUrl,
    status: 'sent',
  });

  return {
    status: persist.ok ? 'sent' : 'failed_persist',
    date: isoDate,
    root: merkle.root,
    entry_count: merkle.entry_count,
    first_id: merkle.first_id,
    last_id: merkle.last_id,
    tx_hash: txHash,
    basescan_url: basescanUrl,
    ...(persist.ok ? {} : { error: persist.error }),
  };
}

/* -------------------------------------------------------------------------- */
/* Test hooks                                                                  */
/* -------------------------------------------------------------------------- */

export const _internals = {
  leafHash,
  pairHash,
  buildMerkleRoot,
  dateBoundsUtc,
};
