/**
 * x402-resilient.ts — local EIP-3009 verification fallback when the x402.org facilitator is down (B4).
 *
 * Wraps X402Facilitator.verifyPayment. When the remote facilitator is unreachable (facilitatorPing
 * fails) AND the flag X402_LOCAL_VERIFY_FALLBACK is ON, the VERIFY path degrades to a local check of the
 * EIP-3009 `transferWithAuthorization` payload: recover the signer from the typed-data signature and
 * confirm it matches `authorization.from`, and validate `value/validAfter/validBefore/to`. SETTLEMENT is
 * NOT performed here and still respects the `cb_disable_x402_settlements` circuit breaker — local verify
 * lets the request be *judged*, not paid.
 *
 * Default OFF: with X402_LOCAL_VERIFY_FALLBACK unset, verifyPayment behaves exactly as today (remote
 * facilitator only). Publishes `SurfaceHealth{surface:'x402'}`.
 */
import { ethers } from 'ethers';
import { x402Facilitator, type PaymentRequirements, type VerifyResult } from './x402-facilitator';
import { getActiveNetwork } from '../config/network';
import { publishHealth } from '../resilience/health-bus';
import type { SurfaceHealth } from '../resilience/types';

const X402_BREAKER_THRESHOLD = 3;
const X402_BREAKER_COOLDOWN_MS = 60_000;

let consecutiveErrors = 0;
let openUntil = 0;
let latencyMsEwma = 0;
let lastSuccessAt: number | null = null;
let lastError: string | undefined;

function localFallbackEnabled(): boolean {
  return process.env.X402_LOCAL_VERIFY_FALLBACK === 'true';
}

function facilitatorEndpoint(): string {
  try {
    return getActiveNetwork().x402.facilitatorUrl;
  } catch {
    return 'x402.org/facilitator';
  }
}

function publishX402Health(latencyMs: number, ok: boolean, mode: 'remote' | 'local', err?: string): void {
  try {
    consecutiveErrors = ok ? 0 : consecutiveErrors + 1;
    if (!ok && consecutiveErrors >= X402_BREAKER_THRESHOLD) {
      openUntil = Date.now() + X402_BREAKER_COOLDOWN_MS;
    }
    if (ok) {
      lastSuccessAt = Date.now();
      lastError = undefined;
    } else if (err) {
      lastError = err;
    }
    latencyMsEwma = latencyMsEwma === 0 ? latencyMs : 0.3 * latencyMs + 0.7 * latencyMsEwma;
    const open = Date.now() < openUntil;
    publishHealth({
      surface: 'x402',
      endpoint: mode === 'local' ? 'local-eip3009' : facilitatorEndpoint(),
      healthy: ok && !open,
      state: open ? 'open' : consecutiveErrors > 0 ? 'half-open' : 'closed',
      latencyMsEwma,
      errorRate: consecutiveErrors > 0 ? Math.min(1, consecutiveErrors / X402_BREAKER_THRESHOLD) : 0,
      lastSuccessAt: lastSuccessAt ?? undefined,
      lastError,
    });
  } catch {
    /* ignore */
  }
}

/** Lightweight reachability probe to the facilitator. Never throws; returns up/down + latency. */
export async function facilitatorPing(): Promise<{ ok: boolean; latencyMs: number }> {
  const start = Date.now();
  const url = facilitatorEndpoint();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 3000);
  try {
    // Facilitators expose /verify; a HEAD/GET to the base URL is enough to know the host is up.
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const latencyMs = Date.now() - start;
    // Any HTTP response (even 404/405) means the host is reachable.
    return { ok: res.status > 0, latencyMs };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(id);
  }
}

/** Decode a base64 X-PAYMENT header into its payload object (best-effort, mirrors the facilitator). */
function decodePaymentHeader(xPaymentHeader: string): any {
  try {
    return JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
  } catch {
    return { txHash: xPaymentHeader };
  }
}

/**
 * Verify an EIP-3009 transferWithAuthorization payload locally (no facilitator). Recovers the signer
 * from the typed-data signature and checks it equals `authorization.from`, plus the time-window and
 * required value/recipient. Returns the same `VerifyResult` shape as the remote path.
 */
export async function verifyEip3009Local(
  xPaymentHeader: string,
  requirements: PaymentRequirements | PaymentRequirements[]
): Promise<VerifyResult> {
  const reqObj = Array.isArray(requirements) ? requirements[0] : requirements;
  if (!reqObj) return { valid: false, payer: '', reason: 'Requirements must not be empty' };

  const payload = decodePaymentHeader(xPaymentHeader);
  const auth = payload.authorization ?? payload;
  const from: string | undefined = auth.from ?? payload.from;
  const to: string | undefined = auth.to ?? payload.to;
  const value = auth.value ?? payload.value;
  const validAfter = auth.validAfter ?? payload.validAfter;
  const validBefore = auth.validBefore ?? payload.validBefore;
  const nonce = auth.nonce ?? payload.nonce;

  let signature: string | undefined = payload.signature;
  if (!signature && payload.r && payload.s && payload.v !== undefined) {
    try {
      signature = ethers.Signature.from({ r: payload.r, s: payload.s, v: Number(payload.v) }).serialized;
    } catch {
      /* leave undefined */
    }
  }

  if (!from || !to || value === undefined || validAfter === undefined || validBefore === undefined || !nonce || !signature) {
    return { valid: false, payer: from ?? '', reason: 'Incomplete EIP-3009 authorization payload' };
  }

  // Time window
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(validAfter)) return { valid: false, payer: from, reason: 'Authorization not yet valid (validAfter)' };
  if (now >= Number(validBefore)) return { valid: false, payer: from, reason: 'Authorization expired (validBefore)' };

  // Required amount / recipient (from the payment requirements)
  try {
    if (BigInt(value) < BigInt(reqObj.maxAmountRequired)) {
      return { valid: false, payer: from, reason: 'Insufficient authorized value' };
    }
  } catch {
    return { valid: false, payer: from, reason: 'Unparseable value' };
  }
  if (reqObj.payTo && to.toLowerCase() !== reqObj.payTo.toLowerCase()) {
    return { valid: false, payer: from, reason: 'Recipient (to) does not match payTo' };
  }

  // Recover the signer from the EIP-712 transferWithAuthorization typed data.
  const net = getActiveNetwork();
  const domain = {
    name: reqObj.extra?.name || 'USDC',
    version: reqObj.extra?.version || '2',
    chainId: net.chainId,
    verifyingContract: reqObj.asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = { from, to, value: value.toString(), validAfter, validBefore, nonce };

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(domain, types, message, signature);
  } catch (e: any) {
    return { valid: false, payer: from, reason: `Signature recovery failed: ${e.message}` };
  }

  if (recovered.toLowerCase() !== from.toLowerCase()) {
    return { valid: false, payer: from, reason: 'Signature does not match authorization.from' };
  }

  return { valid: true, payer: from };
}

/**
 * Resilient verifyPayment: try the remote facilitator first; on facilitator-down + flag-on, fall back
 * to local EIP-3009 verification. Settlement is unaffected (still facilitator + cb_disable_x402_settlements).
 */
export async function resilientVerifyPayment(
  xPaymentHeader: string,
  requirements: PaymentRequirements | PaymentRequirements[]
): Promise<VerifyResult & { mode: 'remote' | 'local' }> {
  const start = Date.now();

  // If the breaker is open and local fallback is available, skip the dead remote call.
  const remoteLikelyDown = Date.now() < openUntil;

  if (!remoteLikelyDown) {
    try {
      const result = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
      // A facilitator HTTP/transport error surfaces as valid:false with a "Facilitator error" reason —
      // treat that as a remote failure for breaker purposes, but still return the result if not falling back.
      const remoteFailed = result.reason?.startsWith('Facilitator error') ?? false;
      publishX402Health(Date.now() - start, !remoteFailed, 'remote', remoteFailed ? result.reason : undefined);
      if (!remoteFailed) return { ...result, mode: 'remote' };
    } catch (err) {
      publishX402Health(Date.now() - start, false, 'remote', err instanceof Error ? err.message : String(err));
    }
  }

  // Remote failed or breaker open → local fallback (if enabled).
  if (localFallbackEnabled()) {
    const localStart = Date.now();
    const ping = await facilitatorPing();
    if (!ping.ok) {
      const local = await verifyEip3009Local(xPaymentHeader, requirements);
      publishX402Health(Date.now() - localStart, local.valid, 'local', local.valid ? undefined : local.reason);
      return { ...local, mode: 'local' };
    }
    // Facilitator pings OK but verify failed — re-attempt remote once (transient), else report.
    try {
      const retry = await x402Facilitator.verifyPayment(xPaymentHeader, requirements);
      publishX402Health(Date.now() - localStart, retry.valid, 'remote', retry.valid ? undefined : retry.reason);
      return { ...retry, mode: 'remote' };
    } catch (err) {
      const local = await verifyEip3009Local(xPaymentHeader, requirements);
      publishX402Health(Date.now() - localStart, local.valid, 'local', local.valid ? undefined : local.reason);
      return { ...local, mode: 'local' };
    }
  }

  // Fallback disabled → return a clear remote-down result (no silent success).
  return {
    valid: false,
    payer: '',
    reason: 'x402 facilitator unavailable and local verify fallback disabled (X402_LOCAL_VERIFY_FALLBACK)',
    mode: 'remote',
  };
}

/** Current health snapshot for the 'x402' surface. */
export function x402Health(): SurfaceHealth[] {
  const open = Date.now() < openUntil;
  return [
    {
      surface: 'x402',
      endpoint: facilitatorEndpoint(),
      healthy: !open,
      state: open ? 'open' : consecutiveErrors > 0 ? 'half-open' : 'closed',
      latencyMsEwma,
      errorRate: consecutiveErrors > 0 ? Math.min(1, consecutiveErrors / X402_BREAKER_THRESHOLD) : 0,
      lastSuccessAt: lastSuccessAt ?? undefined,
      lastError,
    },
  ];
}

/** Test-only: reset x402 resilience state. */
export function __resetX402Resilience(): void {
  consecutiveErrors = 0;
  openUntil = 0;
  latencyMsEwma = 0;
  lastSuccessAt = null;
  lastError = undefined;
}
