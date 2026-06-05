/**
 * EAS Attestation Service for R3 (HyperDAG-bound, our merkle_root only).
 * No borrowed UIDs. Attests payload containing merkle_root from repid_zkp_proofs.
 * Requires EAS_ATTESTER_PRIVATE_KEY (Sean funded on Base Sepolia).
 * Schema: constitutional-compliance-v1 with agentId, tier, merkleRoot etc.
 * Red team: on-chain getAttestation decode must == DB row merkle etc.
 */
import { ethers, Contract, Wallet, JsonRpcProvider, solidityPackedKeccak256, AbiCoder, Interface } from 'ethers';
import { db } from '../db';

export const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
export const SCHEMA_REGISTRY = '0x4200000000000000000000000000000000000020';
const RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

export const PROOF_SCHEMA = 'constitutional-compliance-v1';
export const PROOF_SCHEMA_DEF = 'string agentId,string tier,bytes32 merkleRoot,uint256 repidSnapshot,string proofType,uint64 proofId';

export interface ProofAttestInput {
  proofId: number;
  agentId: string;
  tier: string;
  merkleRoot: string;
  repidSnapshot?: number | null;
  proofType?: string;
}

let provider: JsonRpcProvider | null = null;
let wallet: Wallet | null = null;

function getProvider() {
  if (!provider) provider = new JsonRpcProvider(RPC);
  return provider;
}

function getSigner() {
  // XC fix (c28360e): the funded Base-Sepolia attester wallet is HYPERDAG_ATTESTOR_PRIVATE_KEY;
  // EAS_ATTESTER_PRIVATE_KEY is the legacy/fallback name. HYPERDAG primary.
  const pk = process.env.HYPERDAG_ATTESTOR_PRIVATE_KEY || process.env.EAS_ATTESTER_PRIVATE_KEY;
  if (!pk) return null;
  if (!wallet) wallet = new Wallet(pk, getProvider());
  return wallet;
}

export function hasAttesterKey(): boolean { return !!getSigner(); }

export async function attestProof(input: ProofAttestInput): Promise<{ uid: string | null; txHash: string | null; error?: string }> {
  const signer = getSigner();
  if (!signer) return { uid: null, txHash: null, error: 'HYPERDAG_ATTESTOR_PRIVATE_KEY (or EAS_ATTESTER_PRIVATE_KEY) missing (Sean provision + fund; confirm live Railway var name matches)' };
  if (!input.merkleRoot) return { uid: null, txHash: null, error: 'only HyperDAG merkle_root proofs qualify' };

  const eas = new Contract(EAS_CONTRACT, [
    'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) external payable returns (bytes32)',
    'function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))'
  ], signer);

  const resolver = '0x0000000000000000000000000000000000000000';
  const revocable = true;
  const schemaUid = solidityPackedKeccak256(['string','address','bool'], [PROOF_SCHEMA_DEF, resolver, revocable]);

  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['string','string','bytes32','uint256','string','uint64'],
    [input.agentId, input.tier, input.merkleRoot, BigInt(input.repidSnapshot || 0), input.proofType || 'POSTCARD', BigInt(input.proofId)]
  );

  const req = {
    schema: schemaUid,
    data: {
      recipient: '0x0000000000000000000000000000000000000000',
      expirationTime: 0,
      revocable,
      refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
      data: encoded,
      value: 0
    }
  };

  try {
    const tx = await (eas as any).attest(req);
    const rc = await tx.wait();
    // parse event for uid
    const iface = new Interface(['event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema)']);
    let uid: string | null = null;
    for (const log of rc.logs || []) {
      try {
        const p = iface.parseLog({ topics: log.topics, data: log.data });
        if (p && p.name === 'Attested') { uid = p.args.uid; break; }
      } catch {}
    }
    return { uid, txHash: rc?.hash || tx.hash };
  } catch (e: any) {
    return { uid: null, txHash: null, error: e?.message || 'attest failed' };
  }
}

export async function redTeamPayloadMatch(row: { id: number; agent_id: string | null; tier_proven: string; merkle_root: string | null; eas_attestation_uid: string | null }): Promise<{ match: boolean; details: string; explorer?: string }> {
  if (!row.eas_attestation_uid) return { match: false, details: 'no uid' };
  const signer = getProvider(); // read only
  const eas = new Contract(EAS_CONTRACT, ['function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))'], signer);
  try {
    const att = await (eas as any).getAttestation(row.eas_attestation_uid);
    const dec = AbiCoder.defaultAbiCoder().decode(['string','string','bytes32','uint256','string','uint64'], att.data);
    const match = dec[0] === (row.agent_id || '') && dec[1] === row.tier_proven && (dec[2] || '').toLowerCase() === (row.merkle_root || '').toLowerCase();
    const explorer = `https://base-sepolia.easscan.org/attestation/view/${row.eas_attestation_uid}`;
    return { match, details: match ? 'PAYLOAD_MATCH (HyperDAG merkle/agent/tier)' : 'MISMATCH', explorer };
  } catch (e: any) {
    return { match: false, details: e?.message || 'fetch fail' };
  }
}

export const easService = { hasAttesterKey, attestProof, redTeamPayloadMatch };
