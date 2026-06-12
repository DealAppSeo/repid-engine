/**
 * REPID-E1 — commit-reveal research-integrity anchor (P2).
 *
 * Pre-registration integrity for a research run, on the live Base-Sepolia EAS path:
 *   COMMIT  (before any data): anchor keccak256 of the canonical bundle
 *           {frozen pre-registration + sealed task-set + seeds + analysis-code hash}.
 *   REVEAL  (after the run):  publish the Merkle root over the run's output_hashes
 *           (the e1_response_ledger leaves), as a second attestation that refs the commit.
 *
 * The on-chain SEND is HELD for Sean (co-sign). By default every function here PREPARES the
 * attestation (schemaUid + ABI-encoded data + the exact `cast send`); it only broadcasts when
 * explicitly told to (`send: true`) AND the funded attester key is present.
 *
 * Dedicated schema (proposed — cleaner than reusing the repid `constitutional-compliance-v1`
 * schema, whose agentId/tier/repidSnapshot fields don't fit a research commit):
 *   string runId, string phase, bytes32 rootHash, uint64 timestamp, string artifactUri
 * One-time registration is a Sean-co-signed cast (see `registerCommitRevealSchemaCommand`).
 */
import { keccak256, toUtf8Bytes, AbiCoder, solidityPackedKeccak256, Wallet, Contract, JsonRpcProvider } from 'ethers';

export const E1_SCHEMA_DEF = 'string runId,string phase,bytes32 rootHash,uint64 timestamp,string artifactUri';
const EAS_CONTRACT = '0x4200000000000000000000000000000000000021'; // Base Sepolia EAS
const SCHEMA_REGISTRY = '0x4200000000000000000000000000000000000020';
const RESOLVER = '0x0000000000000000000000000000000000000000';
const REVOCABLE = true;
const ZERO32 = '0x' + '0'.repeat(64);

export type Phase = 'COMMIT' | 'REVEAL';

/** Deterministic JSON: sorted keys, no insignificant whitespace. The hash is only as honest as this. */
export function canonicalize(value: unknown): string {
  const sort = (v: any): any =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, k) => ((o[k] = sort(v[k])), o), {} as any)
      : Array.isArray(v) ? v.map(sort) : v;
  return JSON.stringify(sort(value));
}

export interface PreRegistrationBundle {
  preRegistration: unknown;   // the frozen hypotheses / analysis plan
  taskSet: unknown;           // the sealed task instances (ids + inputs, or their hashes)
  seeds: number[] | string[]; // the RNG/sampling seeds, frozen before any data
  analysisCodeHash: string;   // sha256/keccak of the analysis code tree (e.g. `git rev-parse HEAD` + tree hash)
}

/** The pre-registration commitment hash (bytes32). Anchor THIS before producing any data. */
export function computeCommitHash(bundle: PreRegistrationBundle): string {
  return keccak256(toUtf8Bytes(canonicalize(bundle)));
}

/** Keccak256 binary Merkle root over the run's output_hashes (the e1_response_ledger leaves).
 *  Odd level → duplicate the last node (standard). Leaves must be 0x-prefixed 32-byte hex. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ZERO32;
  let level = leaves.map((l) => (l.startsWith('0x') ? l : '0x' + l));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = (i + 1 < level.length ? level[i + 1] : level[i])!; // duplicate last if odd
      next.push(keccak256('0x' + a.slice(2) + b.slice(2)));
    }
    level = next;
  }
  return level[0]!;
}

/** The dedicated commit-reveal schema UID (derived the same way the EAS service derives the repid one). */
export function e1SchemaUid(): string {
  return solidityPackedKeccak256(['string', 'address', 'bool'], [E1_SCHEMA_DEF, RESOLVER, REVOCABLE]);
}

export interface AttestationPlan {
  phase: Phase;
  runId: string;
  rootHash: string;        // commitHash (COMMIT) or reveal merkle root (REVEAL)
  schemaUid: string;
  encodedData: string;     // ABI-encoded attestation data
  refUID: string;          // commit UID for a REVEAL; 0x00.. for a COMMIT
  castCommand: string;     // exact Sean cast send (held)
}

/** Prepare (do NOT send) an attestation for a commit or reveal. */
export function buildAttestation(args: {
  phase: Phase;
  runId: string;
  rootHash: string;
  timestamp: number;            // unix seconds (pass in — Date.now is non-deterministic across replays)
  artifactUri?: string;
  commitUID?: string;           // required for REVEAL to link back to the commit
}): AttestationPlan {
  const { phase, runId, rootHash, timestamp } = args;
  const schemaUid = e1SchemaUid();
  const refUID = phase === 'REVEAL' ? (args.commitUID ?? ZERO32) : ZERO32;
  if (phase === 'REVEAL' && refUID === ZERO32) {
    throw new Error('REVEAL attestation must reference the COMMIT uid (commitUID)');
  }
  const encodedData = AbiCoder.defaultAbiCoder().encode(
    ['string', 'string', 'bytes32', 'uint64', 'string'],
    [runId, phase, rootHash, BigInt(timestamp), args.artifactUri ?? ''],
  );
  // The EAS attest() request tuple, abi-encoded for `cast send` (recipient 0x0, no expiry, no value).
  const requestData = AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'tuple(address,uint64,bool,bytes32,bytes,uint256)'],
    [schemaUid, [RESOLVER, 0n, REVOCABLE, refUID, encodedData, 0n]],
  );
  const castCommand =
    `# E1 ${phase} anchor (Sean-only on-chain send) — schema ${schemaUid}\n` +
    `cast send ${EAS_CONTRACT} "attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))" ` +
    `'(${schemaUid},(${RESOLVER},0,${REVOCABLE},${refUID},${encodedData},0))' ` +
    `--rpc-url $BASE_SEPOLIA_RPC_URL --private-key $HYPERDAG_ATTESTOR_PRIVATE_KEY`;
  return { phase, runId, rootHash, schemaUid, encodedData, refUID, castCommand };
}

/** One-time schema registration command (Sean co-signs). Only needed if the dedicated schema is adopted. */
export function registerCommitRevealSchemaCommand(): string {
  return (
    `# Register the E1 commit-reveal schema (one-time, Sean-only). Returns the schema UID = ${e1SchemaUid()}\n` +
    `cast send ${SCHEMA_REGISTRY} "register(string,address,bool)" ` +
    `"${E1_SCHEMA_DEF}" ${RESOLVER} ${REVOCABLE} ` +
    `--rpc-url $BASE_SEPOLIA_RPC_URL --private-key $HYPERDAG_ATTESTOR_PRIVATE_KEY`
  );
}

/** BROADCAST an attestation (Sean path only). Returns the on-chain uid. Guarded: needs the funded key. */
export async function sendAttestation(plan: AttestationPlan, rpcUrl: string): Promise<{ uid: string; txHash: string }> {
  const pk = process.env.HYPERDAG_ATTESTOR_PRIVATE_KEY || process.env.EAS_ATTESTER_PRIVATE_KEY;
  if (!pk) throw new Error('HYPERDAG_ATTESTOR_PRIVATE_KEY not set — on-chain send is Sean-only');
  const wallet = new Wallet(pk, new JsonRpcProvider(rpcUrl));
  const eas = new Contract(
    EAS_CONTRACT,
    ['function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) external payable returns (bytes32)'],
    wallet,
  );
  const req = {
    schema: plan.schemaUid,
    data: { recipient: RESOLVER, expirationTime: 0n, revocable: REVOCABLE, refUID: plan.refUID, data: plan.encodedData, value: 0n },
  };
  const tx = await (eas as any).attest(req);
  const receipt = await tx.wait();
  return { uid: receipt?.logs?.[0]?.topics?.[3] ?? '', txHash: tx.hash };
}
