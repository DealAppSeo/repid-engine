/**
 * Agent wallet manager — DB-custodied signing keys for newly-registered
 * human agents.
 *
 * Background: historically only the 12 pre-keyed Trinity agents could sign or
 * transact, because their private keys live in env vars ({AGENT}_PRIVATE_KEY).
 * A new human's agent got a fake `0xAGENT_…` registry address and NO key, so it
 * could never settle x402 payments. This manager provisions a real EVM wallet
 * at registration, stores the public address on repid_agents.wallet_address,
 * and stores the private key ENCRYPTED (AES-GCM) in the agent_secrets table.
 *
 * ── SECURITY FLAG (human/Sean review required) ──────────────────────────────
 * Custody model here is interim application-level encryption under a single
 * env master key (AGENT_KEY_MASTER). Production must move to KMS/Vault. See the
 * header of agent-key-crypto.ts. Do not ship to real user funds without sign-off.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { ethers } from 'ethers';
import { db } from '../db';
import {
  encryptPrivateKey,
  decryptPrivateKey,
  EncryptedKeyBlob,
} from './agent-key-crypto';

export interface ProvisionedWallet {
  address: string;
  /** Encrypted blob ready to persist to agent_secrets.encrypted_private_key. */
  encrypted: EncryptedKeyBlob;
  keyVersion: number;
}

/**
 * Generate a fresh random EVM wallet and return the public address plus the
 * encrypted private key. The plaintext private key NEVER leaves this function.
 */
export function provisionWallet(): ProvisionedWallet {
  const wallet = ethers.Wallet.createRandom();
  const encrypted = encryptPrivateKey(wallet.privateKey);
  return {
    address: wallet.address,
    encrypted,
    // The blob's OWN version, not the compile-time default. Stamping the constant
    // makes agent_secrets.key_version disagree with the ciphertext the first time
    // anyone rotates the master key — and that column is what a rotation sweep
    // reads to decide which rows are left.
    keyVersion: encrypted.v,
  };
}

/**
 * Persist a provisioned wallet: set repid_agents.wallet_address and insert the
 * encrypted key into agent_secrets. Best-effort audit is left to the caller.
 * Returns the public address on success.
 */
export async function persistProvisionedWallet(
  agentId: string,
  provisioned: ProvisionedWallet
): Promise<{ ok: boolean; address?: string; error?: string }> {
  try {
    const nowIso = new Date().toISOString();

    const { error: secretErr } = await db.from('agent_secrets').insert({
      agent_id: agentId,
      encrypted_private_key: provisioned.encrypted,
      key_version: provisioned.keyVersion,
      created_at: nowIso,
    });
    if (secretErr) {
      return { ok: false, error: `agent_secrets insert failed: ${secretErr.message}` };
    }

    const { error: agentErr } = await db
      .from('repid_agents')
      .update({ wallet_address: provisioned.address })
      .eq('id', agentId);
    if (agentErr) {
      return { ok: false, error: `wallet_address update failed: ${agentErr.message}` };
    }

    return { ok: true, address: provisioned.address };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'persistProvisionedWallet failed' };
  }
}

/**
 * Fetch + decrypt the custodied private key for an agent. Returns null when the
 * agent has no custodied secret (e.g. Trinity agents, which use env keys).
 */
export async function getDecryptedPrivateKey(agentId: string): Promise<string | null> {
  const { data, error } = await db
    .from('agent_secrets')
    .select('encrypted_private_key, key_version')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const blob = (data as any).encrypted_private_key as EncryptedKeyBlob;
  if (!blob) return null;

  return decryptPrivateKey(blob);
}

/**
 * Fund a freshly-provisioned wallet with a small amount of testnet ETH for gas.
 *
 * ── STUB (flagged for wiring) ───────────────────────────────────────────────
 * Not yet wired. Two production options, pick per environment:
 *   1. Base Sepolia faucet API call (rate-limited, needs faucet key), OR
 *   2. A DEPLOYER_PRIVATE_KEY-signed native-ETH transfer from a funded hot
 *      wallet (deterministic, but the hot wallet must be topped up + monitored).
 * Until wired, this returns { funded: false, stub: true } and does NOT touch
 * the chain. Callers must treat unfunded wallets as "cannot pay own gas yet"
 * (EIP-3009 gasless transfers still work; native-gas txs will fail).
 * ────────────────────────────────────────────────────────────────────────────
 */
export async function fundWithTestnetETH(
  address: string,
  amountEth = '0.001'
): Promise<{ funded: boolean; stub: boolean; txHash?: string; note?: string }> {
  if (!ethers.isAddress(address)) {
    return { funded: false, stub: true, note: `invalid address: ${address}` };
  }
  // TODO(wiring): call faucet or DEPLOYER_PRIVATE_KEY transfer. See header.
  console.warn(
    `[agent-wallet-manager] fundWithTestnetETH is a stub — wallet ${address} not funded (requested ${amountEth} ETH).`
  );
  return {
    funded: false,
    stub: true,
    note: 'faucet/DEPLOYER transfer not wired — see fundWithTestnetETH header',
  };
}
