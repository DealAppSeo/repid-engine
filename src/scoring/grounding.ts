/**
 * grounding.ts — the ONE engine-side evidence resolver (LOOP C8).
 *
 * Client-supplied strings never count. g_verified is assigned only after this
 * module re-checks the join. Shadow writes the label beside the existing delta
 * and does not change current_repid.
 *
 * Idempotency: one evidence item grounds exactly one scoring event, unique on
 * (evidence_id, agent_id, event_type). Without that, grounding is decorative.
 */
import { createHash } from 'node:crypto';

export const GROUNDING_FLOOR_USD = 0.10;
/** Same (from, to) pair cannot stack g_verified inside this window. */
export const WASH_WINDOW_MS = 60 * 60 * 1000;
export const USDC_DECIMALS = 6;
export const USDC_FLOOR_UNITS = BigInt(Math.round(GROUNDING_FLOOR_USD * 10 ** USDC_DECIMALS));

/** Canonical Base Sepolia USDC. Payment logs from any other address do not ground. */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export type GVerified = 0 | 'low' | 'high';
export type EvidenceKind = 'payment' | 'validation' | 'protocol';

export type GroundingMode = 'off' | 'shadow' | 'enforce';

export function parseGroundingMode(raw: string | undefined | null): GroundingMode {
  const v = (raw ?? 'off').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/** Enforce: ungrounded events contribute 0 delta. Default OFF — shadow/off leave delta alone. */
export function enforceGroundedDelta(delta: number, g: GVerified, mode: GroundingMode): number {
  if (mode !== 'enforce') return delta;
  return g === 0 ? 0 : delta;
}

export function groundingMode(): GroundingMode {
  return parseGroundingMode(process.env.GROUNDING_MODE);
}

export interface PaymentEvidence {
  kind: 'payment';
  txHash: string;
  /** Caller may set this; the resolver ignores it and re-reads the chain. */
  claimedAmountUsd?: number;
  /** Explicit simulated flag. Dust/simulated never ground. */
  isSimulated?: boolean;
  tokenAddress?: string;
}

export interface ValidationEvidence {
  kind: 'validation';
  /** HAL verdict hash. Must be bound to the artifact it judged. */
  verdictHash: string;
  artifactHash: string;
}

export interface ProtocolEvidence {
  kind: 'protocol';
  /** Merged commit SHA, or a validation-record id. */
  commitSha?: string;
  validationRecordId?: string;
}

export type GroundingEvidence = PaymentEvidence | ValidationEvidence | ProtocolEvidence;

export interface ChainTx {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  blockNumber: number | null;
}

export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
}

export interface ChainReceipt {
  status: number | null;
  logs: ChainLog[];
  blockNumber: number | null;
}

export interface ChainReader {
  chainId: number;
  /** True when this chain is a local ephemeral (anvil) and the tx is post-fork. */
  isSimulatedTx?(tx: ChainTx): boolean;
  getTransaction(txHash: string): Promise<ChainTx | null>;
  getReceipt(txHash: string): Promise<ChainReceipt | null>;
}

export interface ValidationRecord {
  verdictHash: string;
  artifactHash: string;
}

export interface ProtocolRecord {
  commitSha?: string;
  validationRecordId?: string;
  merged: boolean;
}

export interface ValidationLookup {
  getByVerdictHash(verdictHash: string): Promise<ValidationRecord | null>;
}

export interface ProtocolLookup {
  get(evidence: ProtocolEvidence): Promise<ProtocolRecord | null>;
}

export interface GroundingClaimRow {
  evidence_id: string;
  agent_id: string;
  event_type: string;
  g_verified: GVerified;
  reason: string;
  created_at: string;
  from_addr?: string | null;
  to_addr?: string | null;
}

export interface GroundingStore {
  findClaim(
    evidenceId: string,
    agentId: string,
    eventType: string,
  ): Promise<GroundingClaimRow | null>;
  /** X9 fix (optional): unique on evidence_id alone. */
  findClaimByEvidence?(evidenceId: string): Promise<GroundingClaimRow | null>;
  findRecentPair?(fromAddr: string, toAddr: string, sinceIso: string): Promise<GroundingClaimRow | null>;
  insertClaim(row: GroundingClaimRow): Promise<'ok' | 'duplicate'>;
}

/**
 * E1: unique is evidence_id only. One settlement grounds at most one scoring event,
 * across agents. GROUNDING_EVIDENCE_UNIQUE=agent is a test-only rollback to the
 * hole X9 found; production default is global.
 */
export function evidenceUniqueScope(
  raw: string | undefined | null = process.env.GROUNDING_EVIDENCE_UNIQUE,
): 'agent' | 'global' {
  return (raw ?? 'global').trim().toLowerCase() === 'agent' ? 'agent' : 'global';
}

export interface GroundingResult {
  g_verified: GVerified;
  reason: string;
  evidence_id: string | null;
  reused: boolean;
  amount_usd: number | null;
  parties: { from: string | null; to: string | null } | null;
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const curr = new Promise<void>((r) => {
    release = r;
  });
  locks.set(key, prev.then(() => curr));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === curr) locks.delete(key);
  }
}

export function evidenceIdOf(evidence: GroundingEvidence): string {
  if (evidence.kind === 'payment') {
    return createHash('sha256').update(`payment:${normHex(evidence.txHash)}`).digest('hex');
  }
  if (evidence.kind === 'validation') {
    return createHash('sha256')
      .update(`validation:${normHex(evidence.verdictHash)}:${normHex(evidence.artifactHash)}`)
      .digest('hex');
  }
  const body = evidence.commitSha
    ? `commit:${evidence.commitSha.toLowerCase()}`
    : `record:${(evidence.validationRecordId ?? '').toLowerCase()}`;
  return createHash('sha256').update(`protocol:${body}`).digest('hex');
}

function normHex(h: string): string {
  return (h || '').trim().toLowerCase();
}

function eqAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function topicAddr(topic: string | undefined): string | null {
  if (!topic || topic.length < 40) return null;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function parseUsdcTransfer(
  receipt: ChainReceipt,
  tokenAddress: string,
): { from: string; to: string; units: bigint } | null {
  const token = tokenAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    if ((log.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = topicAddr(log.topics[1]);
    const to = topicAddr(log.topics[2]);
    if (!from || !to) continue;
    try {
      const units = BigInt(log.data);
      return { from, to, units };
    } catch {
      continue;
    }
  }
  return null;
}

export function createMemoryGroundingStore(): GroundingStore {
  const rows = new Map<string, GroundingClaimRow>();
  const key = (e: string, a: string, t: string) => `${e}\0${a}\0${t}`;
  return {
    async findClaim(e, a, t) {
      return rows.get(key(e, a, t)) ?? null;
    },
    async findClaimByEvidence(evidenceId) {
      for (const row of rows.values()) {
        if (row.evidence_id === evidenceId) return row;
      }
      return null;
    },
    async findRecentPair(fromAddr, toAddr, sinceIso) {
      const f = fromAddr.toLowerCase();
      const t = toAddr.toLowerCase();
      for (const row of rows.values()) {
        if (
          row.g_verified !== 0 &&
          (row.from_addr || '').toLowerCase() === f &&
          (row.to_addr || '').toLowerCase() === t &&
          row.created_at >= sinceIso
        ) {
          return row;
        }
      }
      return null;
    },
    async insertClaim(row) {
      for (const existing of rows.values()) {
        if (existing.evidence_id === row.evidence_id) return 'duplicate';
      }
      const k = key(row.evidence_id, row.agent_id, row.event_type);
      rows.set(k, row);
      return 'ok';
    },
  };
}

function zero(reason: string, extra: Partial<GroundingResult> = {}): GroundingResult {
  return {
    g_verified: 0,
    reason,
    evidence_id: extra.evidence_id ?? null,
    reused: extra.reused ?? false,
    amount_usd: extra.amount_usd ?? null,
    parties: extra.parties ?? null,
  };
}

export interface ResolveGroundingInput {
  agentId: string;
  eventType: string;
  evidence?: GroundingEvidence | null;
  /** Engine-known wallets for this agent. Client-supplied addresses never go here. */
  agentWallets: string[];
  store: GroundingStore;
  chain?: ChainReader;
  validationLookup?: ValidationLookup;
  protocolLookup?: ProtocolLookup;
  now?: Date;
}

/**
 * Resolve g_verified. Never throws into a score path — fail closed to 0.
 */
export async function resolveGrounding(input: ResolveGroundingInput): Promise<GroundingResult> {
  try {
    return await resolveGroundingInner(input);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return zero(`resolver_error:${msg.slice(0, 120)}`);
  }
}

async function resolveGroundingInner(input: ResolveGroundingInput): Promise<GroundingResult> {
  if (!input.evidence) return zero('ungrounded');
  const evidence = input.evidence;

  const evidenceId = evidenceIdOf(evidence);
  const scope = evidenceUniqueScope();
  const lockKey = scope === 'global' ? `e:${evidenceId}` : `${evidenceId}:${input.agentId}:${input.eventType}`;

  return withLock(lockKey, async () => {
    const existing =
      scope === 'global' && input.store.findClaimByEvidence
        ? await input.store.findClaimByEvidence(evidenceId)
        : await input.store.findClaim(evidenceId, input.agentId, input.eventType);
    if (existing) {
      return zero('duplicate_evidence', { evidence_id: evidenceId, reused: true });
    }

    let resolved: GroundingResult;
    if (evidence.kind === 'payment') {
      resolved = await resolvePayment(evidence, input);
    } else if (evidence.kind === 'validation') {
      resolved = await resolveValidation(evidence, input);
    } else {
      resolved = await resolveProtocol(evidence, input);
    }

    resolved = { ...resolved, evidence_id: evidenceId };

    if (resolved.g_verified !== 0) {
      const inserted = await input.store.insertClaim({
        evidence_id: evidenceId,
        agent_id: input.agentId,
        event_type: input.eventType,
        g_verified: resolved.g_verified,
        reason: resolved.reason,
        created_at: (input.now ?? new Date()).toISOString(),
        from_addr: resolved.parties?.from ?? null,
        to_addr: resolved.parties?.to ?? null,
      });
      if (inserted === 'duplicate') {
        return zero('duplicate_evidence', { evidence_id: evidenceId, reused: true });
      }
    }

    return resolved;
  });
}

async function resolvePayment(
  evidence: PaymentEvidence,
  input: ResolveGroundingInput,
): Promise<GroundingResult> {
  if (evidence.isSimulated) return zero('simulated');
  if (!input.chain) return zero('chain_not_checked');

  const txHash = normHex(evidence.txHash);
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return zero('malformed_tx_hash');

  const tx = await input.chain.getTransaction(txHash);
  if (!tx) return zero('tx_not_found');
  const receipt = await input.chain.getReceipt(txHash);
  if (!receipt) return zero('receipt_not_found');
  if (receipt.status !== 1) return zero('tx_failed');

  if (input.chain.isSimulatedTx?.(tx)) return zero('simulated');

  const token = evidence.tokenAddress ?? BASE_SEPOLIA_USDC;
  const transfer = parseUsdcTransfer(receipt, token);
  if (!transfer) return zero('no_usdc_transfer');

  const amountUsd = Number(transfer.units) / 10 ** USDC_DECIMALS;
  const parties = { from: transfer.from, to: transfer.to };

  const wallets = input.agentWallets.map((w) => w.toLowerCase());
  const partyHit = wallets.some((w) => w === transfer.from || w === transfer.to);
  if (!partyHit) return zero('parties_mismatch', { amount_usd: amountUsd, parties });

  // E2: floor is EXCLUSIVE of the bound. Looping exactly $0.10 does not ground.
  if (transfer.units <= USDC_FLOOR_UNITS) {
    return zero('below_floor', { amount_usd: amountUsd, parties });
  }

  const nowMs = (input.now ?? new Date()).getTime();
  if (input.store.findRecentPair) {
    const since = new Date(nowMs - WASH_WINDOW_MS).toISOString();
    const prior = await input.store.findRecentPair(transfer.from, transfer.to, since);
    if (prior) return zero('wash_window', { amount_usd: amountUsd, parties });
  }

  // High: verified payment, parties join, at/above floor. Low reserved for
  // confirmations-short (not modeled here — a receipt.status===1 is final on
  // the pinned fork).
  return {
    g_verified: 'high',
    reason: 'payment_verified',
    evidence_id: null,
    reused: false,
    amount_usd: amountUsd,
    parties,
  };
}

async function resolveValidation(
  evidence: ValidationEvidence,
  input: ResolveGroundingInput,
): Promise<GroundingResult> {
  if (!input.validationLookup) return zero('validation_not_checked');
  const rec = await input.validationLookup.getByVerdictHash(normHex(evidence.verdictHash));
  if (!rec) return zero('verdict_not_found');
  if (normHex(rec.artifactHash) !== normHex(evidence.artifactHash)) {
    return zero('artifact_unbound');
  }
  if (normHex(rec.verdictHash) !== normHex(evidence.verdictHash)) {
    return zero('verdict_mismatch');
  }
  return {
    g_verified: 'high',
    reason: 'validation_bound',
    evidence_id: null,
    reused: false,
    amount_usd: null,
    parties: null,
  };
}

async function resolveProtocol(
  evidence: ProtocolEvidence,
  input: ResolveGroundingInput,
): Promise<GroundingResult> {
  if (!evidence.commitSha && !evidence.validationRecordId) return zero('protocol_empty');
  if (!input.protocolLookup) return zero('protocol_not_checked');
  const rec = await input.protocolLookup.get(evidence);
  if (!rec) return zero('protocol_not_found');
  if (!rec.merged) return zero('commit_not_merged');
  return {
    g_verified: 'high',
    reason: 'protocol_merged',
    evidence_id: null,
    reused: false,
    amount_usd: null,
    parties: null,
  };
}

/**
 * Map a caller-supplied `{kind, ref}` onto resolver evidence. Strings that are
 * not a well-formed tx hash / sha are ignored — they never count as grounded.
 */
export function evidenceFromCallerRef(
  evidence?: { kind: string; ref: string } | null,
): GroundingEvidence | null {
  if (!evidence?.ref) return null;
  const kind = (evidence.kind || '').toLowerCase();
  const ref = evidence.ref.trim();
  if (kind === 'payment' || kind === 'tx' || kind === 'tx_hash') {
    return { kind: 'payment', txHash: ref };
  }
  if (kind === 'validation' || kind === 'hal') {
    const [verdictHash, artifactHash] = ref.split(':');
    if (!verdictHash || !artifactHash) return null;
    return { kind: 'validation', verdictHash, artifactHash };
  }
  if (kind === 'protocol' || kind === 'commit') {
    return { kind: 'protocol', commitSha: ref };
  }
  return null;
}
