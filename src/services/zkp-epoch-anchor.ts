/**
 * ZKP epoch anchoring — closes the prove → aggregate → anchor → verify chain
 * for agent POSTCARD proofs (sprint 2026-05-29).
 *
 * BACKGROUND (Phase 1 audit): repid_zkp_proofs has 22k+ POSTCARD rows, each
 * with a zk_commitment, but merkle_root and eas_attestation_uid are NULL on
 * 100% — both were NEVER WIRED:
 *   - merkle_root: proof-drain-service writes whatever `merkle_root` the prover
 *     returns, but the per-proof postcard prover never returns one (it has no
 *     view of the epoch). There was no aggregator call site.
 *   - eas_attestation_uid: proof-drain-service explicitly left it NULL ("EAS
 *     flow is V1.x"). There was no anchor call site.
 *
 * This module supplies BOTH missing call sites:
 *   aggregateEpoch() — roll one epoch's commitments into ONE merkle_root and
 *     back-fill it across the epoch's rows.
 *   anchorEpoch()    — anchor that single root via ONE EAS attestation on Base
 *     (one attestation per epoch, amortized) and back-fill eas_attestation_uid.
 *   verifyProofViaAnchor() — third-party verify-back: a proof's tier membership
 *     in the anchored root, WITHOUT the underlying data.
 *
 * ┌─ INVARIANT-1 FLAG (sha256 → Poseidon2) — SURFACE, DO NOT DECIDE ─────────┐
 * │ Per ZKP_ARCHITECTURE_INVARIANTS Invariant 1, both proving tiers should   │
 * │ use Poseidon2 over a Plonky3-native field so leaves are aggregation-ready│
 * │ for the recursive-STARK tier. TODAY the POSTCARD commitments are HMAC-    │
 * │ SHA256 (src/zkp/plonky3-real.ts) and this module's Merkle layer is        │
 * │ keccak256 (matching the live audit-merkle-anchor + EAS-anchorable on      │
 * │ Base). That CLOSES the anchor/verify chain on assets we already have, but │
 * │ it is NOT a Plonky3 recursive-STARK aggregation and the leaves are NOT    │
 * │ Poseidon2. Migrating commitments + leaves to Poseidon2 is the make-or-    │
 * │ break compatibility decision for true recursion; it is FLAGGED for        │
 * │ Sean/XC, not made here. No mock-as-real: this is honestly a keccak256     │
 * │ Merkle aggregation, not a STARK recursion proof. [rule:7,11]             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Sim/testnet only. On-chain EAS send is DEFERRED to Sean (keys/funds/deploy).
 */

import { keccak256, getBytes, concat, toUtf8Bytes, ZeroHash, AbiCoder, Interface, solidityPackedKeccak256, JsonRpcProvider, Wallet } from 'ethers';
import { db } from '../db';
import { pgQuery } from '../db/direct-pg';
import { buildMerkleRoot } from './audit-merkle-anchor';
// Hash-AGNOSTIC root (sprint 2026-05-29): the epoch root is computed via an
// injectable scheme so it survives the sha256→Poseidon2 dual-prover migration.
// Default 'keccak256' = byte-identical to PR #73 (epochLeaf/buildMerkleRoot below).
import { getHashScheme, buildRoot, DEFAULT_HASH_SCHEME } from '../zkp/merkle-root';

/* -------------------------------------------------------------------------- */
/* EAS constants (Base Sepolia)                                               */
/* -------------------------------------------------------------------------- */

// Canonical EAS deployment on Base Sepolia (predeploy-style addresses).
export const EAS_CONTRACT_BASE_SEPOLIA = '0x4200000000000000000000000000000000000021';
export const SCHEMA_REGISTRY_BASE_SEPOLIA = '0x4200000000000000000000000000000000000020';
const BASE_SEPOLIA_RPC_DEFAULT = 'https://sepolia.base.org';

// Domain-parameterized per Invariant 3/6 — NOT ownership-specific, so future
// verticals (B: health) reuse the same anchor/verifier with a different domain.
export const ANCHOR_DOMAIN = 'repid-postcard-epoch';
// Written into repid_zkp_proofs.eas_schema for anchored rows (distinct from the
// per-proof default 'constitutional-compliance-v1').
export const EAS_SCHEMA_LABEL = 'repid-postcard-epoch-v1';
// EAS schema definition string (the registered schema's field layout).
export const EAS_SCHEMA_STRING =
  'string domain,bytes32 merkleRoot,string epoch,uint64 proofCount,uint64 firstId,uint64 lastId';

/* -------------------------------------------------------------------------- */
/* Merkle leaf + inclusion proof (keccak256, Bitcoin-style — see Invariant flag) */
/* -------------------------------------------------------------------------- */

/** Leaf = keccak256(commitment-bytes). Deterministic, 32 bytes. */
export function epochLeaf(commitment: string): string {
  return keccak256(toUtf8Bytes(commitment));
}

function pairHash(a: string, b: string): string {
  return keccak256(concat([getBytes(a), getBytes(b)]));
}

export interface MerkleInclusionProof {
  leaf: string;
  index: number;
  siblings: Array<{ hash: string; position: 'left' | 'right' }>;
  root: string;
}

/**
 * Build an inclusion proof for leaf `index` against a Bitcoin-style tree
 * (odd level → duplicate last). Mirrors buildMerkleRoot's pairing exactly so
 * verifyMerkleProof reproduces the same root.
 */
export function buildMerkleProof(leaves: string[], index: number): MerkleInclusionProof {
  if (leaves.length === 0) throw new Error('cannot build proof over empty leaf set');
  if (index < 0 || index >= leaves.length) throw new Error(`index ${index} out of range`);

  const siblings: Array<{ hash: string; position: 'left' | 'right' }> = [];
  let level = leaves.slice();
  let idx = index;

  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // odd → duplicate
      next.push(pairHash(left, right));
    }
    // Record the sibling of idx at this level.
    if (idx % 2 === 0) {
      const rightIdx = idx + 1 < level.length ? idx + 1 : idx; // duplicated self when odd
      siblings.push({ hash: level[rightIdx]!, position: 'right' });
    } else {
      siblings.push({ hash: level[idx - 1]!, position: 'left' });
    }
    idx = Math.floor(idx / 2);
    level = next;
  }

  return { leaf: leaves[index]!, index, siblings, root: level[0]! };
}

/** Recompute the root from a leaf + its siblings and compare. */
export function verifyMerkleProof(proof: MerkleInclusionProof): boolean {
  let acc = proof.leaf;
  for (const s of proof.siblings) {
    acc = s.position === 'left' ? pairHash(s.hash, acc) : pairHash(acc, s.hash);
  }
  return acc.toLowerCase() === proof.root.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* Epoch selection + aggregation (Phase 2)                                     */
/* -------------------------------------------------------------------------- */

export interface EpochProofRow { id: number; zk_commitment: string }

export interface EpochSpec {
  /** Inclusive UTC start ISO. */ start: string;
  /** Exclusive UTC end ISO.   */ end: string;
  /** Human label, e.g. '2026-05-28'. */ label: string;
}

/** UTC-day epoch bounds, matching the audit-merkle-anchor cadence. */
export function dayEpoch(date: Date): EpochSpec {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const start = `${y}-${m}-${d}T00:00:00.000Z`;
  const next = new Date(Date.UTC(y, date.getUTCMonth(), date.getUTCDate() + 1));
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
  return { start, end, label: `${y}-${m}-${d}` };
}

export interface EpochRootResult {
  root: string;
  proof_count: number;
  first_id: number | null;
  last_id: number | null;
  ids: number[];
  leaves: string[];
  /** Hash scheme used to build the root (default keccak256). */
  scheme: string;
  /** Distinct commitments in the epoch — < proof_count means duplicate leaves
   *  (the PR #74 nonce fix is not yet live; anchor soundness caveat). */
  distinct_commitments: number;
}

export interface EpochComputeOpts {
  /** Hash scheme name ('keccak256' default, 'sha256', 'poseidon2' when migrated). */
  schemeName?: string;
  /** Post-nonce CUTOFF: only include proofs with id > afterId (anchor unique-commitment proofs only). */
  afterId?: number;
}

/**
 * Select an epoch's POSTCARD proofs and compute one merkle root over their
 * commitments with a hash-AGNOSTIC scheme. Read is on the hot path → direct pg
 * [rule:8]. Reads repid_zkp_proofs ONLY (deconfliction: no RepID-score table).
 */
export async function computeEpochMerkleRoot(epoch: EpochSpec, opts: EpochComputeOpts = {}): Promise<EpochRootResult> {
  const scheme = getHashScheme(opts.schemeName ?? DEFAULT_HASH_SCHEME);
  const afterId = opts.afterId ?? 0;
  const rows = await pgQuery<EpochProofRow>(
    `SELECT id, zk_commitment
       FROM repid_zkp_proofs
      WHERE proof_type = 'POSTCARD'
        AND zk_commitment IS NOT NULL
        AND created_at >= $1 AND created_at < $2
        AND id > $3
      ORDER BY id ASC`,
    [epoch.start, epoch.end, afterId],
    { retries: 2, label: 'zkp-epoch-select' },
  );

  if (rows.length === 0) {
    return { root: ZeroHash, proof_count: 0, first_id: null, last_id: null, ids: [], leaves: [], scheme: scheme.name, distinct_commitments: 0 };
  }
  const leaves = rows.map(r => scheme.leaf(r.zk_commitment));
  const root = buildRoot(leaves, scheme.pair);
  return {
    root,
    proof_count: rows.length,
    first_id: rows[0]!.id,
    last_id: rows[rows.length - 1]!.id,
    ids: rows.map(r => r.id),
    leaves,
    scheme: scheme.name,
    distinct_commitments: new Set(rows.map(r => r.zk_commitment)).size,
  };
}

export interface AggregateResult extends EpochRootResult {
  epoch: string;
  rows_updated: number;
  persisted: boolean;
}

/**
 * Phase 2 — compute the epoch root and (when persist) back-fill merkle_root on
 * every row in the epoch. The UPDATE is the previously-missing aggregator call
 * site. Hot-path write → direct pg [rule:8]. Writes repid_zkp_proofs ONLY.
 *
 * DRY-RUN BY DEFAULT (persist defaults false) — mirrors the decay-loop operator
 * pattern; the operator script passes persist:true only under --apply.
 */
export async function aggregateEpoch(epoch: EpochSpec, opts: { persist?: boolean } & EpochComputeOpts = {}): Promise<AggregateResult> {
  const r = await computeEpochMerkleRoot(epoch, opts);
  let rows_updated = 0;
  if (opts.persist && r.proof_count > 0) {
    const updated = await pgQuery<{ id: number }>(
      `UPDATE repid_zkp_proofs SET merkle_root = $1
        WHERE id = ANY($2::bigint[])
      RETURNING id`,
      [r.root, r.ids],
      { retries: 2, label: 'zkp-epoch-aggregate-update' },
    );
    rows_updated = updated.length;
  }
  return { ...r, epoch: epoch.label, rows_updated, persisted: !!opts.persist };
}

/* -------------------------------------------------------------------------- */
/* EAS anchor (Phase 3) — construction is real; on-chain send is Sean-deferred */
/* -------------------------------------------------------------------------- */

/** EAS schema UID = keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function computeSchemaUid(schema: string, resolver: string, revocable: boolean): string {
  return solidityPackedKeccak256(['string', 'address', 'bool'], [schema, resolver, revocable]);
}

const EAS_ATTEST_ABI = [
  'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data) request) external payable returns (bytes32)',
];

export interface EasAttestationRequest {
  easContract: string;
  schemaUid: string;
  schemaString: string;
  domain: string;
  merkleRoot: string;
  epoch: string;
  proofCount: number;
  /** ABI-encoded schema payload (the `data` field of the attestation). */
  encodedData: string;
  /** Full calldata for EAS.attest(...) — what Sean's wallet broadcasts. */
  attestCalldata: string;
  /** The exact on-chain action Sean takes (deploy/keys/funds are Sean-only). */
  seanAction: string;
}

/**
 * Build the EAS attestation request for an epoch root. REAL encoding (the
 * calldata is broadcast-ready); the send itself is deferred to Sean.
 */
export function buildEasAttestationRequest(args: {
  root: string; epoch: string; proofCount: number; firstId: number; lastId: number;
  resolver?: string; revocable?: boolean;
}): EasAttestationRequest {
  const resolver = args.resolver ?? '0x0000000000000000000000000000000000000000';
  const revocable = args.revocable ?? true;
  const schemaUid = computeSchemaUid(EAS_SCHEMA_STRING, resolver, revocable);

  // Encode the schema payload: (string domain, bytes32 merkleRoot, string epoch,
  // uint64 proofCount, uint64 firstId, uint64 lastId).
  const encodedData = AbiCoder.defaultAbiCoder().encode(
    ['string', 'bytes32', 'string', 'uint64', 'uint64', 'uint64'],
    [ANCHOR_DOMAIN, args.root, args.epoch, args.proofCount, args.firstId, args.lastId],
  );

  const iface = new Interface(EAS_ATTEST_ABI);
  const attestCalldata = iface.encodeFunctionData('attest', [
    {
      schema: schemaUid,
      data: {
        recipient: '0x0000000000000000000000000000000000000000',
        expirationTime: 0n,
        revocable,
        refUID: ZeroHash,
        data: encodedData,
        value: 0n,
      },
    },
  ]);

  return {
    easContract: EAS_CONTRACT_BASE_SEPOLIA,
    schemaUid,
    schemaString: EAS_SCHEMA_STRING,
    domain: ANCHOR_DOMAIN,
    merkleRoot: args.root,
    epoch: args.epoch,
    proofCount: args.proofCount,
    encodedData,
    attestCalldata,
    seanAction:
      `Sean action (on-chain, deferred): (1) ensure schema "${EAS_SCHEMA_STRING}" is registered on Base Sepolia ` +
      `SchemaRegistry ${SCHEMA_REGISTRY_BASE_SEPOLIA} (schemaUid=${schemaUid}); ` +
      `(2) send the prepared attestCalldata to EAS ${EAS_CONTRACT_BASE_SEPOLIA} from the funded deployer; ` +
      `(3) the tx receipt's Attested event yields the attestation UID → pass it to recordEpochAnchorUid().`,
  };
}

/**
 * P3 — the EXACT on-chain command block for Sean (one action). NOT executed
 * here (Railway/on-chain = Sean-only). Two `cast` commands: register the schema
 * once, then attest the epoch root. After sending, Sean passes the receipt's
 * Attested UID to recordEpochAnchorUid() to back-fill eas_attestation_uid.
 */
export function buildSeanCommand(eas: EasAttestationRequest, opts: { firstId: number; lastId: number; idCount: number; resolver?: string; revocable?: boolean }): string {
  const resolver = opts.resolver ?? '0x0000000000000000000000000000000000000000';
  const revocable = (opts.revocable ?? true) ? 'true' : 'false';
  return [
    `# === EAS anchor for epoch ${eas.epoch} (Sean-only; do not run unattended) ===`,
    `# Covers ${opts.idCount} POSTCARD proofs, repid_zkp_proofs.id ${opts.firstId}..${opts.lastId}`,
    `# merkle_root: ${eas.merkleRoot}`,
    `# schema:      ${eas.schemaString}`,
    `# schemaUid:   ${eas.schemaUid}`,
    `# EAS:         ${eas.easContract}   SchemaRegistry: ${SCHEMA_REGISTRY_BASE_SEPOLIA}   (Base Sepolia, chainId 84532)`,
    `export RPC=$BASE_SEPOLIA_RPC_URL          # e.g. https://sepolia.base.org`,
    `export PK=$AUDIT_ANCHOR_PRIVATE_KEY        # funded Base Sepolia key (Sean)`,
    ``,
    `# 1) Register the schema ONCE (skip if schemaUid already registered):`,
    `cast send ${SCHEMA_REGISTRY_BASE_SEPOLIA} "register(string,address,bool)" \\`,
    `  "${eas.schemaString}" ${resolver} ${revocable} --rpc-url $RPC --private-key $PK`,
    ``,
    `# 2) Attest the epoch root (broadcast-ready calldata):`,
    `cast send ${eas.easContract} ${eas.attestCalldata} --rpc-url $RPC --private-key $PK`,
    ``,
    `# 3) Read the Attested UID from the receipt, then back-fill:`,
    `#    recordEpochAnchorUid({start:'${''}', ...}, '<attestationUID>')  (operator script --record <uid>)`,
  ].join('\n');
}

export type AnchorStatus = 'aggregated_deferred' | 'aggregated_anchored' | 'no_proofs';

export interface AnchorResult {
  status: AnchorStatus;
  epoch: string;
  root: string;
  proof_count: number;
  rows_updated_merkle: number;
  eas: EasAttestationRequest | null;
  eas_attestation_uid: string | null;
  rows_updated_eas: number;
}

/**
 * Phase 3 — aggregate the epoch then build (and, only if a key is present AND
 * sendOnChain=true, send) the single EAS attestation. Default: DEFER the send
 * to Sean and return the broadcast-ready request. On-chain send is gated behind
 * an explicit flag + AUDIT_ANCHOR_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY (Sean-only).
 */
export async function anchorEpoch(
  epoch: EpochSpec,
  opts: { persist?: boolean; sendOnChain?: boolean } & EpochComputeOpts = {},
): Promise<AnchorResult> {
  // DRY-RUN default: persist only when explicitly requested (operator --apply).
  const agg = await aggregateEpoch(epoch, { persist: opts.persist ?? false, schemeName: opts.schemeName, afterId: opts.afterId });
  if (agg.proof_count === 0) {
    return { status: 'no_proofs', epoch: epoch.label, root: agg.root, proof_count: 0, rows_updated_merkle: 0, eas: null, eas_attestation_uid: null, rows_updated_eas: 0 };
  }

  const eas = buildEasAttestationRequest({
    root: agg.root, epoch: epoch.label, proofCount: agg.proof_count,
    firstId: agg.first_id ?? 0, lastId: agg.last_id ?? 0,
  });

  // On-chain send is Sean-only. Even with sendOnChain=true we require a key to
  // be explicitly present; absent that, we stop at the prepared request.
  const key = (process.env.AUDIT_ANCHOR_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || '').trim();
  if (opts.sendOnChain && key) {
    const rpc = process.env.BASE_SEPOLIA_RPC_URL || BASE_SEPOLIA_RPC_DEFAULT;
    const wallet = new Wallet(key, new JsonRpcProvider(rpc));
    const tx = await wallet.sendTransaction({ to: eas.easContract, data: eas.attestCalldata, value: 0n });
    const receipt = await tx.wait();
    // The attestation UID is the first topic of the Attested event; if not
    // parseable here, Sean reads it from the receipt. We persist the tx hash as
    // a provisional reference and let recordEpochAnchorUid() set the real UID.
    const uid = receipt?.logs?.[0]?.topics?.[1] ?? tx.hash;
    const n = await recordEpochAnchorUid(epoch, uid);
    return { status: 'aggregated_anchored', epoch: epoch.label, root: agg.root, proof_count: agg.proof_count, rows_updated_merkle: agg.rows_updated, eas, eas_attestation_uid: uid, rows_updated_eas: n };
  }

  return { status: 'aggregated_deferred', epoch: epoch.label, root: agg.root, proof_count: agg.proof_count, rows_updated_merkle: agg.rows_updated, eas, eas_attestation_uid: null, rows_updated_eas: 0 };
}

/**
 * Back-fill eas_attestation_uid + eas_schema across an epoch's rows once the
 * on-chain UID is known (called by anchorEpoch after a send, or by Sean's
 * post-broadcast step with the real UID from the tx receipt). Hot write → pg.
 */
export async function recordEpochAnchorUid(epoch: EpochSpec, uid: string): Promise<number> {
  const updated = await pgQuery<{ id: number }>(
    `UPDATE repid_zkp_proofs SET eas_attestation_uid = $1, eas_schema = $2
      WHERE proof_type = 'POSTCARD'
        AND created_at >= $3 AND created_at < $4
    RETURNING id`,
    [uid, EAS_SCHEMA_LABEL, epoch.start, epoch.end],
    { retries: 2, label: 'zkp-epoch-anchor-uid-update' },
  );
  return updated.length;
}

/* -------------------------------------------------------------------------- */
/* Verify-back (Phase 4)                                                       */
/* -------------------------------------------------------------------------- */

export interface VerifyBackResult {
  verified: boolean;
  proof_id: number;
  tier_proven: string | null;
  merkle_root: string | null;
  eas_attestation_uid: string | null;
  inclusion: MerkleInclusionProof | null;
  reason?: string;
}

/**
 * Phase 4 — given a proof id, prove its membership in the anchored epoch root
 * WITHOUT exposing the underlying data: recompute the epoch root, build the
 * proof's inclusion path, verify it reproduces the stored merkle_root. A third
 * party with only (eas_attestation_uid, merkle_root, the proof's commitment +
 * siblings) can confirm the proof's tier membership.
 */
export async function verifyProofViaAnchor(proofId: number): Promise<VerifyBackResult> {
  const rows = await pgQuery<{ id: number; tier_proven: string; merkle_root: string | null; eas_attestation_uid: string | null; created_at: string }>(
    `SELECT id, tier_proven, merkle_root, eas_attestation_uid, created_at
       FROM repid_zkp_proofs WHERE id = $1`,
    [proofId],
    { retries: 2, label: 'zkp-verify-load' },
  );
  const row = rows[0];
  if (!row) return { verified: false, proof_id: proofId, tier_proven: null, merkle_root: null, eas_attestation_uid: null, inclusion: null, reason: 'proof not found' };
  if (!row.merkle_root) return { verified: false, proof_id: proofId, tier_proven: row.tier_proven, merkle_root: null, eas_attestation_uid: row.eas_attestation_uid, inclusion: null, reason: 'proof not yet aggregated (merkle_root null)' };

  const epoch = dayEpoch(new Date(row.created_at));
  const epochRoot = await computeEpochMerkleRoot(epoch);
  const index = epochRoot.ids.indexOf(proofId);
  if (index < 0) return { verified: false, proof_id: proofId, tier_proven: row.tier_proven, merkle_root: row.merkle_root, eas_attestation_uid: row.eas_attestation_uid, inclusion: null, reason: 'proof not in recomputed epoch set' };

  const inclusion = buildMerkleProof(epochRoot.leaves, index);
  const rootMatches = inclusion.root.toLowerCase() === row.merkle_root.toLowerCase();
  const proofValid = verifyMerkleProof(inclusion);

  return {
    verified: rootMatches && proofValid,
    proof_id: proofId,
    tier_proven: row.tier_proven,
    merkle_root: row.merkle_root,
    eas_attestation_uid: row.eas_attestation_uid,
    inclusion,
    ...(rootMatches && proofValid ? {} : { reason: `root match=${rootMatches} inclusion valid=${proofValid}` }),
  };
}
