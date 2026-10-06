/**
 * The ERC-8004 FEEDBACK FILE for one on-chain reputation write, built ONCE and never re-rendered.
 *
 * WHY. ERC-8004 `giveFeedback` carries a `feedbackURI` and a `feedbackHash`: the URI points at an
 * off-chain JSON file and the hash is keccak256 of that file's bytes, so anyone can check that the
 * file they fetch is the one the write committed to (packages/contracts/ERC8004SPEC.md in
 * hyperdag-protocol, "Giving Feedback"). Measured 2026-10-06 on the live write
 * 0x3566…53f3: our feedbackHash was bytes32(0), the URI pointed at a host that answers 404, and
 * the file the engine did serve was recomputed on every request (createdAt = the time you asked,
 * clientAddress "0x0"). No write we had made could be verified end to end.
 *
 * So the file is built here, stored as the EXACT string, and the hash is taken over those bytes.
 * The public route serves the stored string verbatim; it never rebuilds it. A file that changes
 * after the fact cannot match a hash written before it.
 *
 * PROOF OF PAYMENT. The spec's own field for x402 (`proofOfPayment: { fromAddress, toAddress,
 * chainId, txHash }`) is filled only from a settlement row whose tx_hash shows money actually
 * moved, that is not simulated, and whose payment header names the payee. Anything less leaves the
 * field out: an absent proof is NOT CHECKED, a fabricated one would be a lie with a hash on it.
 */
import { ethers } from 'ethers';

export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string;
  chainId: string;
  txHash: string;
}

export interface FeedbackFileInput {
  chainId: number;
  identityRegistry: string;
  /** ERC-721 token id on the IdentityRegistry (the spec's agentId), not our internal UUID. */
  agentTokenId: string;
  /** The address that signs giveFeedback: the event's clientAddress. */
  clientAddress: string;
  createdAt: string;
  value: number;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  proofOfPayment: ProofOfPayment | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The file, as the exact string that is stored, served and hashed. Keys are written in a fixed
 * order (the spec's MUST fields first, as its example lists them) so the same input always gives
 * the same bytes.
 */
export function buildFeedbackFile(i: FeedbackFileInput): string {
  if (!ADDRESS.test(i.identityRegistry)) throw new Error('identityRegistry is not an address');
  if (!ADDRESS.test(i.clientAddress)) throw new Error('clientAddress is not an address');
  if (!/^\d+$/.test(i.agentTokenId)) throw new Error('agentTokenId is not a token id');
  if (!Number.isInteger(i.value) || !Number.isInteger(i.valueDecimals)) throw new Error('value and valueDecimals must be integers');
  const file: Record<string, unknown> = {
    agentRegistry: `eip155:${i.chainId}:${i.identityRegistry}`,
    // A number, as in the spec's example; a token id past 2^53 stays a string rather than lose digits.
    agentId: Number.isSafeInteger(Number(i.agentTokenId)) ? Number(i.agentTokenId) : i.agentTokenId,
    clientAddress: `eip155:${i.chainId}:${i.clientAddress}`,
    createdAt: i.createdAt,
    value: i.value,
    valueDecimals: i.valueDecimals,
    tag1: i.tag1,
    tag2: i.tag2,
    endpoint: i.endpoint,
  };
  if (i.proofOfPayment) file.proofOfPayment = i.proofOfPayment;
  return JSON.stringify(file);
}

/** keccak256 over the UTF-8 bytes of the stored string: what goes on chain as feedbackHash. */
export function feedbackHashOf(file: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(file));
}

/** Where the engine serves the stored file. One file per repid_events row, so one per write. */
export function feedbackFileUrl(baseUrl: string, agentId: string, eventId: string | number): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/agents/${agentId}/reputation/feedback/${eventId}.json`;
}

/** The payee (`authorization.to`) named in a base64 x402 payment header, or null. */
export function payeeFromPaymentHeader(xPaymentHeader: string | null | undefined): string | null {
  if (!xPaymentHeader) return null;
  try {
    const decoded = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8')) as Record<string, unknown>;
    const payload = (decoded['payload'] ?? decoded) as Record<string, unknown>;
    const auth = (payload['authorization'] ?? payload) as Record<string, unknown>;
    const to = auth['to'];
    return typeof to === 'string' && ADDRESS.test(to) ? to : null;
  } catch {
    return null;
  }
}

export interface SettlementRow {
  tx_hash: string | null;
  payer_address: string | null;
  x_payment_header: string | null;
  is_simulated: boolean | null;
}

/**
 * The spec's proofOfPayment from one x402_settlements row, or null when the row does not show a
 * real payment from a named payer to a named payee. Null is reported as NOT CHECKED by the verifier;
 * it is never guessed.
 */
export function proofOfPaymentFrom(row: SettlementRow | null | undefined, chainId: number): ProofOfPayment | null {
  if (!row || row.is_simulated !== false) return null;
  if (!row.tx_hash || !TX_HASH.test(row.tx_hash)) return null;
  if (!row.payer_address || !ADDRESS.test(row.payer_address)) return null;
  const to = payeeFromPaymentHeader(row.x_payment_header);
  if (!to) return null;
  return { fromAddress: row.payer_address, toAddress: to, chainId: String(chainId), txHash: row.tx_hash };
}
