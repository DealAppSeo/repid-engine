/**
 * SBT mint flow — server-side service.
 *
 * Implements the SBT-MINTING-FLOW.md spec (six phases) at v0.1 maturity:
 *   - Phase 1 (challenge + signature) — implemented in full.
 *   - Phase 2 (optional contact layer) — not yet wired here; the endpoint
 *     accepts contact_email_optional but ignores it. v0.2 hooks Supabase
 *     storage with the AES-256-GCM pattern documented in the spec.
 *   - Phase 3 (initial RepID seed) — sets repId=0 by leaving the
 *     repid_score_events table alone. The first trust-building action
 *     creates the first row.
 *   - Phase 4 (mint tx) — calls the same ERC-8004 register() the agent
 *     fleet uses. v1 spec describes a Soulbound-only contract; v0.1
 *     reuses the agent registry and documents the gap.
 *   - Phase 5 (metadata anchoring) — inline data URI by default; if
 *     PINATA_JWT is in env, pins to IPFS instead.
 *   - Phase 6 (commitment publication) — writes to hal_audit_chain via
 *     auditChainWriter.appendToAuditChain.
 *
 * Mock mode: when SBT_MINT_MOCK=1 (or DEPLOYER_PRIVATE_KEY missing),
 * the service returns a deterministic mock mint with `is_mock: true`
 * on every response. Same shape as the real mint so the demo page and
 * downstream consumers don't branch.
 */

import { ethers } from 'ethers';
import { createHash, randomBytes } from 'crypto';
import { db } from '../db';
import { appendToAuditChain } from './auditChainWriter';

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const PROTOCOL_VERSION = 'hyperdag-sbt/v0.1';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;     // 5 min — challenge expires after this
const PINATA_JWT = process.env.PINATA_JWT || '';
const PINATA_PIN_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

const REGISTRY_ABI = [
  'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) external returns (uint256 agentId)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
];

// In-process challenge store. Process-local on purpose — no DB write
// needed for ephemeral nonces, and a process restart simply forces a
// fresh challenge (the holder retries within the TTL).
interface ChallengeRecord {
  challenge: string;
  expiresAt: number;
}
const challengeStore = new Map<string, ChallengeRecord>();

function lower(addr: string): string {
  return addr.toLowerCase();
}

function isMockMode(): boolean {
  if (process.env.SBT_MINT_MOCK === '1') return true;
  if (!process.env.DEPLOYER_PRIVATE_KEY) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1 — challenge issuance + verification
// ---------------------------------------------------------------------------

export interface SbtChallenge {
  challenge: string;
  expires_at: string;
  protocol_version: string;
  message_to_sign: string;
}

export function issueChallenge(holder: string): SbtChallenge {
  if (!ethers.isAddress(holder)) throw new Error('invalid holder address');
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const msg = `HyperDAG SBT mint challenge for ${ethers.getAddress(holder)} (${PROTOCOL_VERSION}); nonce=${nonce}; expiresAt=${new Date(expiresAt).toISOString()}`;
  challengeStore.set(lower(holder), { challenge: msg, expiresAt });
  return {
    challenge: msg,
    expires_at: new Date(expiresAt).toISOString(),
    protocol_version: PROTOCOL_VERSION,
    message_to_sign: msg,
  };
}

export interface ChallengeVerifyResult {
  ok: boolean;
  reason?: 'no_challenge' | 'expired' | 'bad_signature';
  recovered?: string;
}

export function verifySignedChallenge(holder: string, signedChallenge: string): ChallengeVerifyResult {
  const rec = challengeStore.get(lower(holder));
  if (!rec) return { ok: false, reason: 'no_challenge' };
  if (Date.now() > rec.expiresAt) {
    challengeStore.delete(lower(holder));
    return { ok: false, reason: 'expired' };
  }
  try {
    const recovered = ethers.verifyMessage(rec.challenge, signedChallenge);
    const match = lower(recovered) === lower(holder);
    if (!match) return { ok: false, reason: 'bad_signature', recovered };
    return { ok: true, recovered };
  } catch (e) {
    return { ok: false, reason: 'bad_signature' };
  } finally {
    // One-time-use challenge regardless of outcome.
    challengeStore.delete(lower(holder));
  }
}

// ---------------------------------------------------------------------------
// Phase 4-6 — mint, anchor, audit chain entry
// ---------------------------------------------------------------------------

export interface SbtMintInput {
  holder_address: string;
  signed_challenge: string;
  contact_email_optional?: string;
}

export interface SbtMintResult {
  ok: boolean;
  is_mock: boolean;
  status: 'minted' | 'mock' | 'failed';
  tx_hash: string | null;
  token_id: string | null;
  ipfs_metadata_uri: string;
  metadata_inline: boolean;
  rep_id_commitment: string;
  explorer_url: string | null;
  audit_chain_id: number | null;
  protocol_version: string;
  notes?: string;
  error?: string;
}

export interface SbtMintMetadata {
  schema: string;
  holder: string;
  protocol_version: string;
  minted_at: string;
  rep_id_pointer: string;
  verified_attributes: string[];
  extension_capabilities: string[];
}

function buildMetadata(holder: string, repIdCommitment: string, mintedAt: string): SbtMintMetadata {
  return {
    schema: 'hyperdag-sbt/v0.1',
    holder: ethers.getAddress(holder),
    protocol_version: PROTOCOL_VERSION,
    minted_at: mintedAt,
    rep_id_pointer: repIdCommitment,
    verified_attributes: ['wallet_signature_verified'],
    extension_capabilities: ['dbt_delegation', 'cbt_organization_link'],
  };
}

function computeRepIdCommitment(holder: string, nonce: string): string {
  // Phase 6 commitment: H(repIdValue=0 || nonce || holderAddress) at mint
  // time. v0.1 holders start at repId=0, so the first commitment pins
  // exactly that initial state. Future commitments produced as repId
  // changes follow the same shape.
  return '0x' + createHash('sha256')
    .update(Buffer.concat([
      Buffer.alloc(32, 0),                // repIdValue=0 as 32-byte big-endian
      Buffer.from(nonce.replace(/^0x/, ''), 'hex'),
      Buffer.from(ethers.getAddress(holder).slice(2), 'hex'),
    ]))
    .digest('hex');
}

async function pinMetadataToIPFS(metadata: SbtMintMetadata): Promise<string | null> {
  if (!PINATA_JWT) return null;
  try {
    const r = await fetch(PINATA_PIN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PINATA_JWT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pinataContent: metadata }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { IpfsHash?: string };
    return j.IpfsHash ? `ipfs://${j.IpfsHash}` : null;
  } catch {
    return null;
  }
}

function buildInlineDataURI(metadata: SbtMintMetadata): string {
  const json = JSON.stringify(metadata);
  return 'data:application/json;base64,' + Buffer.from(json).toString('base64');
}

export async function mintSBT(input: SbtMintInput): Promise<SbtMintResult> {
  // 1. Verify the holder's signed challenge.
  if (!ethers.isAddress(input.holder_address)) {
    return failResult(input.holder_address, 'invalid holder address');
  }
  const verify = verifySignedChallenge(input.holder_address, input.signed_challenge);
  if (!verify.ok) return failResult(input.holder_address, `challenge verification failed: ${verify.reason}`);

  const holder = ethers.getAddress(input.holder_address);
  const mintedAt = new Date().toISOString();
  const nonce = '0x' + randomBytes(32).toString('hex');
  const repIdCommitment = computeRepIdCommitment(holder, nonce);
  const metadata = buildMetadata(holder, repIdCommitment, mintedAt);

  const ipfsURI = await pinMetadataToIPFS(metadata);
  const tokenURI = ipfsURI ?? buildInlineDataURI(metadata);
  const inline = !ipfsURI;

  // 2. Branch on mock vs real.
  if (isMockMode()) {
    return await produceMockMint(holder, repIdCommitment, tokenURI, inline);
  }

  // 3. Real mint via ERC-8004 register().
  return await produceRealMint(holder, repIdCommitment, tokenURI, inline, metadata);
}

async function produceMockMint(
  holder: string,
  repIdCommitment: string,
  tokenURI: string,
  inline: boolean,
): Promise<SbtMintResult> {
  const fakeTokenId = String(BigInt('0x' + createHash('sha256').update(holder + ':' + repIdCommitment).digest('hex').slice(0, 16)));
  const fakeTx = '0x' + createHash('sha256').update('mock_tx:' + holder + ':' + repIdCommitment).digest('hex');

  let auditId: number | null = null;
  try {
    const audit = await appendToAuditChain('sbt_mint_events', `mock-${fakeTokenId}`, {
      event_type: 'sbt_mint',
      is_mock: true,
      holder, token_id: fakeTokenId, tx_hash: fakeTx, metadata_inline: inline,
    });
    auditId = audit.id;
  } catch (e: any) {
    console.warn('[sbt-mint] audit chain append failed (mock):', e?.message);
  }

  try {
    await db.from('sbt_mint_events').insert({
      holder_address: holder,
      token_id: fakeTokenId,
      tx_hash: fakeTx,
      ipfs_uri: inline ? null : tokenURI,
      metadata_inline: inline,
      rep_id_commitment: repIdCommitment,
      status: 'mock',
      is_mock: true,
      audit_chain_id: auditId,
    });
  } catch (e: any) {
    console.warn('[sbt-mint] sbt_mint_events insert failed:', e?.message);
  }

  return {
    ok: true,
    is_mock: true,
    status: 'mock',
    tx_hash: fakeTx,
    token_id: fakeTokenId,
    ipfs_metadata_uri: tokenURI,
    metadata_inline: inline,
    rep_id_commitment: repIdCommitment,
    explorer_url: null,
    audit_chain_id: auditId,
    protocol_version: PROTOCOL_VERSION,
    notes: 'MOCK_MINT — no on-chain transaction submitted. Set SBT_MINT_MOCK=0 and rotate DEPLOYER_PRIVATE_KEY to the canonical Trinity Deployer wallet to switch to real mints.',
  };
}

async function produceRealMint(
  holder: string,
  repIdCommitment: string,
  tokenURI: string,
  inline: boolean,
  metadata: SbtMintMetadata,
): Promise<SbtMintResult> {
  let auditId: number | null = null;
  let txHash: string | null = null;
  let tokenId: string | null = null;
  try {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY as string, provider);
    const contract = new ethers.Contract(REGISTRY, REGISTRY_ABI, wallet) as unknown as {
      register: (uri: string, md: { metadataKey: string; metadataValue: Uint8Array }[]) => Promise<{ hash: string; wait: (n?: number) => Promise<{ blockNumber: number; logs: any[] }> }>;
      interface: { parseLog: (log: any) => { name: string; args: { agentId: bigint } } | null };
    };
    const md = [
      { metadataKey: 'name',     metadataValue: ethers.toUtf8Bytes('HOLDER_SBT') },
      { metadataKey: 'protocol', metadataValue: ethers.toUtf8Bytes('HyperDAG') },
      { metadataKey: 'schema',   metadataValue: ethers.toUtf8Bytes(metadata.schema) },
    ];
    const tx = await contract.register(tokenURI, md);
    txHash = tx.hash;
    const receipt = await tx.wait(1);
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed && parsed.name === 'Registered') {
          tokenId = parsed.args.agentId.toString();
          break;
        }
      } catch { /* not our event */ }
    }
  } catch (e: any) {
    console.warn('[sbt-mint] real mint failed:', e?.message);
    return failResult(holder, e?.shortMessage ?? e?.message ?? 'mint failed');
  }

  try {
    const audit = await appendToAuditChain('sbt_mint_events', tokenId ?? `pending-${holder}`, {
      event_type: 'sbt_mint',
      is_mock: false,
      holder, token_id: tokenId, tx_hash: txHash, metadata_inline: inline,
    });
    auditId = audit.id;
  } catch (e: any) {
    console.warn('[sbt-mint] audit chain append failed (real):', e?.message);
  }

  try {
    await db.from('sbt_mint_events').insert({
      holder_address: holder,
      token_id: tokenId,
      tx_hash: txHash,
      ipfs_uri: inline ? null : tokenURI,
      metadata_inline: inline,
      rep_id_commitment: repIdCommitment,
      status: 'minted',
      is_mock: false,
      audit_chain_id: auditId,
    });
  } catch (e: any) {
    console.warn('[sbt-mint] sbt_mint_events insert failed:', e?.message);
  }

  return {
    ok: true,
    is_mock: false,
    status: 'minted',
    tx_hash: txHash,
    token_id: tokenId,
    ipfs_metadata_uri: tokenURI,
    metadata_inline: inline,
    rep_id_commitment: repIdCommitment,
    explorer_url: tokenId ? `https://sepolia.basescan.org/token/${REGISTRY}?a=${tokenId}` : null,
    audit_chain_id: auditId,
    protocol_version: PROTOCOL_VERSION,
    notes: 'Live mint. v0.1 reuses the ERC-8004 IdentityRegistry — soulbound-only contract is v1.',
  };
}

function failResult(holder: string, error: string): SbtMintResult {
  return {
    ok: false,
    is_mock: isMockMode(),
    status: 'failed',
    tx_hash: null,
    token_id: null,
    ipfs_metadata_uri: '',
    metadata_inline: true,
    rep_id_commitment: '',
    explorer_url: null,
    audit_chain_id: null,
    protocol_version: PROTOCOL_VERSION,
    error,
    notes: `Failed for holder ${holder}`,
  };
}

// ---------------------------------------------------------------------------
// Read helpers — used by GET /api/v1/sbt/by-holder/:addr
// ---------------------------------------------------------------------------

export async function listMintsByHolder(holder: string, limit = 10): Promise<unknown[]> {
  if (!ethers.isAddress(holder)) return [];
  const { data, error } = await db
    .from('sbt_mint_events')
    .select('id, holder_address, token_id, tx_hash, status, is_mock, ipfs_uri, metadata_inline, rep_id_commitment, audit_chain_id, created_at')
    .ilike('holder_address', holder)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data ?? [];
}
