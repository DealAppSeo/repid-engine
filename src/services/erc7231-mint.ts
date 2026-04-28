/**
 * ERC-7231 mint bridge.
 *
 * Two paths:
 *   - REAL    : env BASE_ERC7231_REGISTRY + DEPLOYER_PRIVATE_KEY set →
 *               ethers v6 call against Base. Returns tx_hash + token_id.
 *   - SIMULATE: either env var missing → returns a deterministic fake
 *               token id (sha256(builder_id||now) prefixed 'sim_') and
 *               is_simulated=true.
 *
 * Either path persists builders.erc7231_token_id and emits an audit row.
 * The contract surface is intentionally minimal: a `mintTo(address)`
 * call returning the new tokenId via event. If the user supplies a
 * different ABI later, only the ethers Contract instance changes.
 */

import { createHash } from 'crypto';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const SIMULATED_PREFIX = 'sim_';

export interface MintResult {
  ok: boolean;
  builder_id: string;
  erc7231_token_id?: string;
  tx_hash?: string;
  is_simulated: boolean;
  error?: string;
}

export async function mintErc7231ForBuilder(builderId: string): Promise<MintResult> {
  const { data: builder, error: bErr } = await db
    .from('builders')
    .select('id, address, erc7231_token_id, email')
    .eq('id', builderId)
    .maybeSingle();
  if (bErr || !builder) {
    return { ok: false, builder_id: builderId, is_simulated: true, error: 'builder not found' };
  }
  if (builder.erc7231_token_id) {
    return {
      ok: true,
      builder_id: builderId,
      erc7231_token_id: builder.erc7231_token_id,
      is_simulated: builder.erc7231_token_id.startsWith(SIMULATED_PREFIX),
    };
  }

  const registry = process.env.BASE_ERC7231_REGISTRY;
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (registry && deployerKey) {
    return await realMint(builderId, builder.address, registry, deployerKey);
  }

  // Simulated path
  const tokenId = SIMULATED_PREFIX + createHash('sha256').update(`${builderId}|${Date.now()}`).digest('hex').slice(0, 16);
  await db.from('builders').update({ erc7231_token_id: tokenId }).eq('id', builderId);
  await emitAuditEvent({
    event_type: 'erc7231_minted',
    source_table: 'builders',
    source_id: builderId,
    payload: { builder_id: builderId, erc7231_token_id: tokenId, is_simulated: true },
  });
  return { ok: true, builder_id: builderId, erc7231_token_id: tokenId, is_simulated: true };
}

async function realMint(builderId: string, address: string, registry: string, deployerKey: string): Promise<MintResult> {
  try {
    const { JsonRpcProvider, Wallet, Contract, Interface } = await import('ethers');
    const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    const provider = new JsonRpcProvider(rpcUrl);
    const wallet = new Wallet(deployerKey, provider);
    const abi = [
      'function mintTo(address to) external returns (uint256)',
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ];
    const contract = new Contract(registry, abi, wallet) as any;
    const tx = await contract.mintTo(address);
    const receipt = await tx.wait();
    let tokenId: string | undefined;
    if (receipt && receipt.logs) {
      const iface = new Interface(abi);
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed?.name === 'Transfer') {
            tokenId = String(parsed.args.tokenId);
            break;
          }
        } catch {
          // not our event
        }
      }
    }
    if (!tokenId) {
      return { ok: false, builder_id: builderId, is_simulated: false, tx_hash: tx.hash, error: 'mint succeeded but no Transfer event found' };
    }
    await db.from('builders').update({ erc7231_token_id: tokenId }).eq('id', builderId);
    await emitAuditEvent({
      event_type: 'erc7231_minted',
      source_table: 'builders',
      source_id: builderId,
      payload: { builder_id: builderId, erc7231_token_id: tokenId, tx_hash: tx.hash, is_simulated: false },
    });
    return { ok: true, builder_id: builderId, erc7231_token_id: tokenId, tx_hash: tx.hash, is_simulated: false };
  } catch (e: any) {
    return { ok: false, builder_id: builderId, is_simulated: false, error: e?.message ?? 'mint failed' };
  }
}
