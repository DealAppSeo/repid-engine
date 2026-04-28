/**
 * On-chain oracle — derive a binary outcome from the latest Base
 * Sepolia block hash.
 *
 *   outcome = lastByte(block.hash) mod 2
 *
 * Deterministic per block (any verifier can reproduce by re-fetching
 * the same block number) and unforgeable without colluding with
 * miners on Base Sepolia. Good enough for demo-grade fairness; not a
 * production randomness beacon (use VRF for that in v1).
 *
 * Falls back to a deterministic HMAC oracle when the RPC is
 * unreachable or returns a malformed block. Every result carries
 * oracle_source so callers can surface it.
 */

import { ethers } from 'ethers';
import { createHmac } from 'crypto';

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const HMAC_SECRET = process.env.ORACLE_HMAC_SECRET || 'reponomics-default-oracle-secret';
const RPC_TIMEOUT_MS = 5000;

export type OracleSource = 'onchain_blockhash' | 'fallback_hmac';

export interface OracleResult {
  outcome: 0 | 1;
  block_number: number;
  block_hash: string;
  basescan_url: string;
  oracle_source: OracleSource;
  notes?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

function hmacFallback(seed: string): OracleResult {
  const h = createHmac('sha256', HMAC_SECRET).update(seed).digest('hex');
  const lastByte = parseInt(h.slice(-2), 16);
  return {
    outcome: (lastByte % 2) as 0 | 1,
    block_number: 0,
    block_hash: '0x' + h,
    basescan_url: '',
    oracle_source: 'fallback_hmac',
    notes: 'fallback_hmac — Base Sepolia RPC unreachable or returned malformed block',
  };
}

/**
 * Read the latest block on Base Sepolia and derive an outcome from
 * its hash. Optional `seed` is mixed into the fallback path so two
 * concurrent fallbacks for different bets produce different outcomes.
 */
export async function deriveOutcomeFromChain(seed: string = 'default'): Promise<OracleResult> {
  let provider: ethers.JsonRpcProvider | null = null;
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const block = await withTimeout(provider.getBlock('latest'), RPC_TIMEOUT_MS);
    if (!block || typeof block.hash !== 'string' || !block.hash.startsWith('0x') || typeof block.number !== 'number') {
      return hmacFallback(seed);
    }
    const lastByte = parseInt(block.hash.slice(-2), 16);
    if (Number.isNaN(lastByte)) return hmacFallback(seed);
    return {
      outcome: (lastByte % 2) as 0 | 1,
      block_number: block.number,
      block_hash: block.hash,
      basescan_url: `https://sepolia.basescan.org/block/${block.number}`,
      oracle_source: 'onchain_blockhash',
    };
  } catch (e: any) {
    return hmacFallback(seed);
  } finally {
    // ethers v6 JsonRpcProvider has destroy() to release sockets in
    // tests; ignore if missing in older minor versions.
    try { (provider as any)?.destroy?.(); } catch { /* ignore */ }
  }
}

// Pure helpers exposed for tests.
export const _internals = { hmacFallback };
