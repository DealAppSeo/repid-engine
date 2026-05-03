/**
 * HyperDAG RepID Trust Receipt — issuer.
 *
 * Takes existing repid-engine pipeline output (HAL signals, x402 payment, task
 * input/result) and produces a v1.0 receipt JSON conforming to
 * `hyperdag-protocol/schemas/receipt.v1.json`.
 *
 * v1.0 scope:
 * - off-chain JSON construction + Supabase persistence
 * - keccak256 hashing of canonical-JSON representations
 * - returns content hash and a receipt URI; does NOT call the on-chain contract
 *   (commit-reveal is orchestrated separately for v1.0)
 *
 * Cross-LLM verification, Pythagorean Comma BFT veto, and the RepID commitment
 * scheme are bound from the existing HAL output produced by `src/routes/v1.ts`'s
 * /hal/signals endpoint and the existing HALSignals shape from
 * `src/services/hal-signals.ts`. Do not redefine those types here.
 */
import { keccak256, toUtf8Bytes } from 'ethers';
import { db } from '../db';
import type { HALSignals } from './hal-signals';

export type Hex32 = `0x${string}`;

/**
 * The HAL output shape consumed by the receipt issuer. Mirrors the response
 * produced by POST /api/v1/hal/signals (see src/routes/v1.ts:29-72). Kept as
 * a separate interface here so the receipt module does not import from the
 * route file directly — the route owns presentation, this service consumes
 * a typed contract.
 */
export interface HALOutputForReceipt {
  signals: HALSignals;
  hal_score: number;
  vetoed: boolean;
  veto_reason: string | null;
  veto_threshold: number;
  comma_veto: boolean;
  comma_gap: number | null;
  comma_severity: 'none' | 'minor' | 'major' | 'critical' | null;
  formula: string;
}

export interface IssueReceiptInput {
  agentId: number;
  agentRegistry?: string;          // defaults to Base Sepolia canonical
  agentWallet: string;
  x402PaymentProof: {
    paymentHash?: string;          // if pre-hashed externally; otherwise computed
    network: string;
    currency: string;
    amount: string;
    resourceUri: string;
    [k: string]: unknown;
  };
  taskInput: object;
  taskResult: object;
  artifact?: object | string;
  halOutput: HALOutputForReceipt;
  repIdCommitment: Hex32;
  scoreVersion: number;            // 5 or 6
  scoreFormulaVersion?: string;    // e.g. 'repid-2026-04-17'
  reputationScore?: number;
  reputationConfidence?: number;
  validators?: Array<{
    role: 'primary' | 'secondary';
    type: 'self' | 'human' | 'validator' | 'zk-stub' | 'trinity-bft';
    attestationHash: Hex32;
    signature?: string;
  }>;
  privacyMode?: 'commitment-only' | 'selective-disclosure' | 'full-zk';
  zkProofType?: string;
  humanIdentityRoot?: Hex32 | null;
}

export interface IssueReceiptOutput {
  receiptJson: Record<string, unknown>;
  receiptUri: string;
  receiptHash: Hex32;
  contractTxHash: string | null;
}

const ERC8004_REGISTRY_BASE_SEPOLIA = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const STORAGE_BUCKET = 'hyperdag-receipts';

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

function keccakOfCanonicalJson(value: unknown): Hex32 {
  return keccak256(toUtf8Bytes(canonicalize(value))) as Hex32;
}

export { canonicalize, keccakOfCanonicalJson };

function commaBftVerdict(halOutput: HALOutputForReceipt): 'pass' | 'veto' | 'indeterminate' {
  if (halOutput.comma_veto) return 'veto';
  if (halOutput.signals.agreement_score === null || halOutput.signals.agreement_score === undefined) {
    return 'indeterminate';
  }
  return 'pass';
}

function dimensionsHash(signals: HALSignals): Hex32 {
  return keccakOfCanonicalJson({
    harm_probability: signals.harm_probability,
    epistemic_uncertainty: signals.epistemic_uncertainty,
    evidence_quality: signals.evidence_quality,
    scope_appropriateness: signals.scope_appropriateness,
    certainty_at_claim: signals.certainty_at_claim,
    agreement_score: signals.agreement_score ?? null,
  });
}

/**
 * Pure helper: build the receipt JSON (schema-conforming) from inputs without
 * touching the database. Useful for tests and for callers that want to inspect
 * the receipt before persisting.
 */
export function buildReceiptJson(input: IssueReceiptInput): {
  receiptJson: Record<string, unknown>;
  receiptContentHash: Hex32;
  x402PaymentHash: Hex32;
  taskHash: Hex32;
  resultHash: Hex32;
  halOutputHash: Hex32;
  halDimensionsHash: Hex32;
  verdict: 'pass' | 'veto' | 'indeterminate';
} {
  if (input.scoreVersion !== 5 && input.scoreVersion !== 6) {
    throw new Error(`Invalid scoreVersion ${input.scoreVersion}: must be 5 or 6`);
  }
  const x402PaymentHash =
    (input.x402PaymentProof.paymentHash as Hex32 | undefined) ?? keccakOfCanonicalJson(input.x402PaymentProof);
  const taskHash = keccakOfCanonicalJson(input.taskInput);
  const resultHash = keccakOfCanonicalJson(input.taskResult);
  const resourceHash = keccak256(toUtf8Bytes(input.x402PaymentProof.resourceUri)) as Hex32;
  const artifactHash =
    input.artifact !== undefined ? keccakOfCanonicalJson(input.artifact) : undefined;
  const halOutputHash = keccakOfCanonicalJson(input.halOutput);
  const halDimsHash = dimensionsHash(input.halOutput.signals);
  const verdict = commaBftVerdict(input.halOutput);

  const receiptJsonNoId: Record<string, unknown> = {
    type: 'hyperdag.repid.receipt.v1',
    agent: {
      standard: 'ERC-8004',
      agentRegistry: input.agentRegistry ?? ERC8004_REGISTRY_BASE_SEPOLIA,
      agentId: String(input.agentId),
      agentWallet: input.agentWallet,
    },
    payment: {
      standard: 'x402',
      paymentHash: x402PaymentHash,
      network: input.x402PaymentProof.network,
      currency: input.x402PaymentProof.currency,
      amount: input.x402PaymentProof.amount,
      resourceHash,
    },
    work: {
      taskHash,
      resultHash,
      ...(artifactHash ? { artifactHash } : {}),
    },
    identity: {
      repIdCommitment: input.repIdCommitment,
      humanIdentityRoot: input.humanIdentityRoot ?? null,
    },
    hal: {
      dofVersion: input.scoreVersion,
      boundedScore: input.halOutput.hal_score,
      commaBftVerdict: verdict,
      dimensionsHash: halDimsHash,
      outputHash: halOutputHash,
      pythagoreanCommaConstant: '531441/524288',
    },
    validators: input.validators ?? [
      {
        role: 'primary',
        type: 'self',
        attestationHash: halOutputHash,
      },
    ],
    reputation: {
      score: input.reputationScore ?? 0,
      scoreVersion: input.scoreVersion,
      formulaVersion: input.scoreFormulaVersion ?? 'repid-2026-04-17',
      ...(input.reputationConfidence !== undefined ? { confidence: input.reputationConfidence } : {}),
    },
    privacy: {
      mode: input.privacyMode ?? 'commitment-only',
      ...(input.zkProofType ? { zkProofType: input.zkProofType } : {}),
    },
    timestamps: {
      createdAt: new Date().toISOString(),
    },
  };

  const receiptContentHash = keccakOfCanonicalJson(receiptJsonNoId);
  const receiptJson = { ...receiptJsonNoId, receiptId: receiptContentHash };
  return {
    receiptJson,
    receiptContentHash,
    x402PaymentHash,
    taskHash,
    resultHash,
    halOutputHash,
    halDimensionsHash: halDimsHash,
    verdict,
  };
}

export async function issueReceipt(input: IssueReceiptInput): Promise<IssueReceiptOutput> {
  if (input.scoreVersion !== 5 && input.scoreVersion !== 6) {
    throw new Error(`Invalid scoreVersion ${input.scoreVersion}: must be 5 or 6`);
  }

  const x402PaymentHash =
    (input.x402PaymentProof.paymentHash as Hex32 | undefined) ?? keccakOfCanonicalJson(input.x402PaymentProof);
  const taskHash = keccakOfCanonicalJson(input.taskInput);
  const resultHash = keccakOfCanonicalJson(input.taskResult);
  const resourceHash = keccak256(toUtf8Bytes(input.x402PaymentProof.resourceUri)) as Hex32;
  const artifactHash =
    input.artifact !== undefined ? keccakOfCanonicalJson(input.artifact) : undefined;

  const halOutputHash = keccakOfCanonicalJson(input.halOutput);
  const halDimsHash = dimensionsHash(input.halOutput.signals);
  const verdict = commaBftVerdict(input.halOutput);

  const receiptJsonNoId: Record<string, unknown> = {
    type: 'hyperdag.repid.receipt.v1',
    agent: {
      standard: 'ERC-8004',
      agentRegistry: input.agentRegistry ?? ERC8004_REGISTRY_BASE_SEPOLIA,
      agentId: String(input.agentId),
      agentWallet: input.agentWallet,
    },
    payment: {
      standard: 'x402',
      paymentHash: x402PaymentHash,
      network: input.x402PaymentProof.network,
      currency: input.x402PaymentProof.currency,
      amount: input.x402PaymentProof.amount,
      resourceHash,
    },
    work: {
      taskHash,
      resultHash,
      ...(artifactHash ? { artifactHash } : {}),
    },
    identity: {
      repIdCommitment: input.repIdCommitment,
      humanIdentityRoot: input.humanIdentityRoot ?? null,
    },
    hal: {
      dofVersion: input.scoreVersion,
      boundedScore: input.halOutput.hal_score,
      commaBftVerdict: verdict,
      dimensionsHash: halDimsHash,
      outputHash: halOutputHash,
      pythagoreanCommaConstant: '531441/524288',
    },
    validators: input.validators ?? [
      {
        role: 'primary',
        type: 'self',
        attestationHash: halOutputHash,
      },
    ],
    reputation: {
      score: input.reputationScore ?? 0,
      scoreVersion: input.scoreVersion,
      formulaVersion: input.scoreFormulaVersion ?? 'repid-2026-04-17',
      ...(input.reputationConfidence !== undefined ? { confidence: input.reputationConfidence } : {}),
    },
    privacy: {
      mode: input.privacyMode ?? 'commitment-only',
      ...(input.zkProofType ? { zkProofType: input.zkProofType } : {}),
    },
    timestamps: {
      createdAt: new Date().toISOString(),
    },
  };

  const receiptContentHash = keccakOfCanonicalJson(receiptJsonNoId);
  const receiptId = receiptContentHash; // off-chain content-address; on-chain receiptId is assigned at reveal and stored separately
  const receiptJson = { ...receiptJsonNoId, receiptId };

  const persistResult = await persistReceipt({
    receiptId,
    receiptJson,
    receiptContentHash,
    agentId: input.agentId,
    agentWallet: input.agentWallet,
    x402PaymentHash,
    taskHash,
    resultHash,
    repIdCommitment: input.repIdCommitment,
    halDofVersion: input.scoreVersion,
    halOutputHash,
    halBoundedScore: input.halOutput.hal_score,
    halCommaBftVerdict: verdict,
    halDimensionsHash: halDimsHash,
    humanIdentityRoot: input.humanIdentityRoot ?? null,
    scoreVersion: input.scoreVersion,
  });

  const receiptUri = persistResult.uri;
  const receiptUriHash = keccak256(toUtf8Bytes(receiptUri)) as Hex32;
  // Persist URI hash so on-chain commit can reference it.
  await db
    .from('hyperdag_receipts')
    .update({ receipt_uri_hash: receiptUriHash })
    .eq('receipt_id', receiptId);

  return {
    receiptJson,
    receiptUri,
    receiptHash: receiptContentHash,
    contractTxHash: null,
  };
}

interface PersistInput {
  receiptId: Hex32;
  receiptJson: Record<string, unknown>;
  receiptContentHash: Hex32;
  agentId: number;
  agentWallet: string;
  x402PaymentHash: Hex32;
  taskHash: Hex32;
  resultHash: Hex32;
  repIdCommitment: Hex32;
  halDofVersion: number;
  halOutputHash: Hex32;
  halBoundedScore: number;
  halCommaBftVerdict: 'pass' | 'veto' | 'indeterminate';
  halDimensionsHash: Hex32;
  humanIdentityRoot: Hex32 | null;
  scoreVersion: number;
}

async function persistReceipt(p: PersistInput): Promise<{ uri: string }> {
  const verdictCode =
    p.halCommaBftVerdict === 'pass' ? 0 : p.halCommaBftVerdict === 'veto' ? 1 : 2;

  const { error: insertErr } = await db.from('hyperdag_receipts').insert({
    receipt_id: p.receiptId,
    agent_id: p.agentId,
    x402_payment_hash: p.x402PaymentHash,
    task_hash: p.taskHash,
    result_hash: p.resultHash,
    rep_id_commitment: p.repIdCommitment,
    hal_dof_version: p.halDofVersion,
    hal_output_hash: p.halOutputHash,
    hal_bounded_score: p.halBoundedScore,
    hal_comma_bft_verdict: verdictCode,
    hal_dimensions_hash: p.halDimensionsHash,
    human_identity_root: p.humanIdentityRoot,
    receipt_uri: '',
    receipt_content_hash: p.receiptContentHash,
    score_version: p.scoreVersion,
    status: 0,
    contract_tx_hash: null,
    committer_address: p.agentWallet,
    receipt_json: p.receiptJson,
  });
  if (insertErr) {
    throw new Error(`receipt insert failed: ${insertErr.message}`);
  }

  const path = `${p.agentId}/${p.receiptId}.json`;
  let uploadedPublicUrl: string | null = null;
  try {
    const storage = (db as any).storage;
    if (storage && typeof storage.from === 'function') {
      const bucket = storage.from(STORAGE_BUCKET);
      const buf = Buffer.from(JSON.stringify(p.receiptJson));
      const upload = await bucket.upload(path, buf, {
        contentType: 'application/json',
        upsert: false,
      });
      if (!upload.error) {
        const { data } = bucket.getPublicUrl(path);
        uploadedPublicUrl = (data?.publicUrl as string | undefined) ?? null;
      }
    }
  } catch (err: unknown) {
    // Storage upload is best-effort in v1.0. Receipt row is the source of truth.
    console.warn('[receipt-issuer] storage upload failed:', (err as Error).message);
  }

  const uri = uploadedPublicUrl ?? `repid:receipt://${p.receiptId}`;
  await db.from('hyperdag_receipts').update({ receipt_uri: uri }).eq('receipt_id', p.receiptId);
  return { uri };
}

export async function getReceiptById(receiptId: string): Promise<Record<string, unknown> | null> {
  const { data } = await db
    .from('hyperdag_receipts')
    .select('receipt_json')
    .eq('receipt_id', receiptId)
    .maybeSingle();
  return ((data as any)?.receipt_json as Record<string, unknown> | undefined) ?? null;
}

export async function listReceiptsByAgent(agentId: number, limit = 50): Promise<Array<{
  receipt_id: string;
  status: number;
  created_at: string;
  hal_comma_bft_verdict: number;
}>> {
  const { data } = await db
    .from('hyperdag_receipts')
    .select('receipt_id,status,created_at,hal_comma_bft_verdict')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data as Array<any>) ?? [];
}
