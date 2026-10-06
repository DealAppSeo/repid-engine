/**
 * Verify ONE ERC-8004 reputation write end to end, as a stranger would: from the chain and the
 * public file, with no access to our database. The pure half lives here so each leg is testable;
 * scripts/verify-feedback-write.ts does the fetching.
 *
 * Every leg is VERIFIED, NOT_CHECKED or FAILED. NOT_CHECKED means "there was nothing to check" or
 * "we could not look" (a write that committed to no hash, a file with no proofOfPayment, an RPC
 * we could not reach). It is never folded into VERIFIED: the overall verdict is VERIFIED only when
 * every leg is.
 */
import { ethers } from 'ethers';

export type Outcome = 'VERIFIED' | 'NOT_CHECKED' | 'FAILED';
export interface Leg {
  leg: 'write' | 'identity' | 'file' | 'fields' | 'payment';
  outcome: Outcome;
  detail: string;
}

export interface DecodedFeedback {
  agentId: string;
  clientAddress: string;
  value: string;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

const ZERO_HASH = '0x' + '0'.repeat(64);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Leg 1: the transaction succeeded, went to the ReputationRegistry, and emitted NewFeedback. */
export function assessWrite(
  receipt: { status: number | null; to: string | null } | null,
  registry: string,
  decoded: DecodedFeedback | null,
): Leg {
  if (!receipt) return { leg: 'write', outcome: 'NOT_CHECKED', detail: 'no receipt: the transaction was not found or the RPC did not answer' };
  if (receipt.status !== 1) return { leg: 'write', outcome: 'FAILED', detail: `transaction status ${receipt.status}, not 1` };
  if (!same(receipt.to, registry)) return { leg: 'write', outcome: 'FAILED', detail: `sent to ${receipt.to}, not the ReputationRegistry ${registry}` };
  if (!decoded) return { leg: 'write', outcome: 'FAILED', detail: 'no NewFeedback event from the ReputationRegistry in this transaction' };
  return { leg: 'write', outcome: 'VERIFIED', detail: `NewFeedback for agentId ${decoded.agentId}, value ${decoded.value}` };
}

/** Leg 2: the agent the feedback is about exists on the IdentityRegistry. */
export function assessIdentity(owner: string | null, readError: string | null): Leg {
  if (readError) return { leg: 'identity', outcome: 'NOT_CHECKED', detail: `ownerOf could not be read: ${readError}` };
  if (!owner || /^0x0{40}$/i.test(owner)) return { leg: 'identity', outcome: 'FAILED', detail: 'the agentId has no owner on the IdentityRegistry' };
  return { leg: 'identity', outcome: 'VERIFIED', detail: `agent registered, owner ${owner}` };
}

/**
 * Leg 3: the file at feedbackURI is the file the write committed to. keccak256 is taken over the
 * bytes as served, never over a re-serialised parse of them.
 */
export function assessFile(
  feedbackHash: string,
  fetched: { status: number; body: Uint8Array } | { error: string },
): Leg {
  if (!feedbackHash || feedbackHash.toLowerCase() === ZERO_HASH) {
    return { leg: 'file', outcome: 'NOT_CHECKED', detail: 'the write committed to no hash (feedbackHash is zero), so no file can be matched to it' };
  }
  if ('error' in fetched) return { leg: 'file', outcome: 'NOT_CHECKED', detail: `feedbackURI could not be fetched from here: ${fetched.error}` };
  if (fetched.status !== 200) return { leg: 'file', outcome: 'FAILED', detail: `feedbackURI answered HTTP ${fetched.status}` };
  const got = ethers.keccak256(fetched.body);
  if (got.toLowerCase() !== feedbackHash.toLowerCase()) {
    return { leg: 'file', outcome: 'FAILED', detail: `keccak256 of the served file is ${got}, the write committed to ${feedbackHash}` };
  }
  return { leg: 'file', outcome: 'VERIFIED', detail: 'keccak256 of the served file equals feedbackHash' };
}

/** Leg 4: what the file says agrees with what the event says. */
export function assessFields(
  file: Record<string, unknown> | null,
  ev: DecodedFeedback,
  chainId: number,
  identityRegistry: string,
): Leg {
  if (!file) return { leg: 'fields', outcome: 'NOT_CHECKED', detail: 'no verified file to compare' };
  const mismatches: string[] = [];
  if (!same(String(file.agentRegistry ?? ''), `eip155:${chainId}:${identityRegistry}`)) mismatches.push('agentRegistry');
  if (String(file.agentId ?? '') !== ev.agentId) mismatches.push('agentId');
  if (!same(String(file.clientAddress ?? ''), `eip155:${chainId}:${ev.clientAddress}`)) mismatches.push('clientAddress');
  if (String(file.value ?? '') !== ev.value) mismatches.push('value');
  if (Number(file.valueDecimals) !== ev.valueDecimals) mismatches.push('valueDecimals');
  if (file.tag1 !== undefined && file.tag1 !== ev.tag1) mismatches.push('tag1');
  if (file.tag2 !== undefined && file.tag2 !== ev.tag2) mismatches.push('tag2');
  if (typeof file.createdAt !== 'string' || Number.isNaN(Date.parse(file.createdAt))) mismatches.push('createdAt');
  if (mismatches.length) return { leg: 'fields', outcome: 'FAILED', detail: `file disagrees with the event on: ${mismatches.join(', ')}` };
  return { leg: 'fields', outcome: 'VERIFIED', detail: 'agentRegistry, agentId, clientAddress, value and tags match the event' };
}

export interface ProofOfPayment {
  fromAddress: string;
  toAddress: string;
  chainId: string;
  txHash: string;
}

/**
 * Leg 5: the payment the file cites happened. x402 settles through a facilitator, so the payment
 * transaction's own `from` is the facilitator; the payer and payee are in the token's Transfer log,
 * and that is what is matched.
 */
export function assessPayment(
  proof: ProofOfPayment | null | undefined,
  paymentReceipt: { status: number | null; logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string> }> } | null | { error: string },
  expectedChainId: number,
): Leg {
  if (!proof) return { leg: 'payment', outcome: 'NOT_CHECKED', detail: 'the file carries no proofOfPayment' };
  if (String(proof.chainId) !== String(expectedChainId)) {
    return { leg: 'payment', outcome: 'NOT_CHECKED', detail: `proofOfPayment is on chain ${proof.chainId}; this run reads chain ${expectedChainId}` };
  }
  if (paymentReceipt && 'error' in paymentReceipt) return { leg: 'payment', outcome: 'NOT_CHECKED', detail: `payment receipt could not be read: ${paymentReceipt.error}` };
  if (!paymentReceipt) return { leg: 'payment', outcome: 'FAILED', detail: `payment transaction ${proof.txHash} not found` };
  if (paymentReceipt.status !== 1) return { leg: 'payment', outcome: 'FAILED', detail: `payment transaction status ${paymentReceipt.status}, not 1` };
  const pad = (a: string) => ethers.zeroPadValue(a, 32).toLowerCase();
  const hit = paymentReceipt.logs.find(
    (l) => l.topics[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics[1]?.toLowerCase() === pad(proof.fromAddress) && l.topics[2]?.toLowerCase() === pad(proof.toAddress),
  );
  if (!hit) return { leg: 'payment', outcome: 'FAILED', detail: `no Transfer from ${proof.fromAddress} to ${proof.toAddress} in ${proof.txHash}` };
  return { leg: 'payment', outcome: 'VERIFIED', detail: `Transfer ${proof.fromAddress} → ${proof.toAddress} on token ${hit.address}` };
}

/**
 * FETCH POLICY for feedbackURI. Anyone can call giveFeedback, so the URI in an event is
 * attacker-chosen: a verifier that fetched it blindly could be pointed at loopback, a private
 * network or a cloud metadata endpoint (SSRF, CWE-918; Strix on #1225). Only a public https URL is
 * fetched; every address the host resolves to must be public, and each redirect hop is re-checked
 * by the caller. A refused URL is NOT_CHECKED, never fetched.
 */
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_REDIRECTS = 3;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.azure.com', 'metadata']);

/** Why this URL may not be fetched, or null when it may (before DNS: see isPublicAddress). */
export function fetchTargetProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:') return `scheme ${url.protocol} is not fetched (https only)`;
  if (url.username || url.password) return 'credentials in the URL';
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) return `host ${host} is not public`;
  if (isIpLiteral(host) && !isPublicAddress(host)) return `address ${host} is not public`;
  return null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** True only for a globally routable unicast address (IPv4 or IPv6). */
export function isPublicAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    return true;
  }
  const v6 = ip.toLowerCase();
  if (!v6.includes(':')) return false;
  // IPv4-mapped, in dotted form or the hex form URL() normalises it to (::ffff:7f00:1).
  const mapped = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPublicAddress(mapped[1]!);
  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // IPv4-compatible (::a.b.c.d, ::7f00:1) and NAT64 (64:ff9b::/96) can reach an IPv4 address
  // this check cannot see: refused rather than guessed.
  if (/^::[0-9a-f.:]+$/.test(v6) || v6.startsWith('64:ff9b:')) return false;
  if (v6 === '::' || v6 === '::1') return false;
  if (/^f[cd]/.test(v6)) return false; // unique local fc00::/7
  if (/^fe[89ab]/.test(v6)) return false; // link-local fe80::/10
  if (/^ff/.test(v6)) return false; // multicast
  return true;
}

/** VERIFIED only when every leg is; any FAILED is FAILED; otherwise NOT_CHECKED. */
export function overall(legs: readonly Leg[]): Outcome {
  if (legs.some((l) => l.outcome === 'FAILED')) return 'FAILED';
  if (legs.every((l) => l.outcome === 'VERIFIED')) return 'VERIFIED';
  return 'NOT_CHECKED';
}

/** 0 VERIFIED, 2 NOT_CHECKED, 1 FAILED: the house convention, so a script cannot read a gap as a pass. */
export function exitCodeOf(o: Outcome): number {
  return o === 'VERIFIED' ? 0 : o === 'NOT_CHECKED' ? 2 : 1;
}
