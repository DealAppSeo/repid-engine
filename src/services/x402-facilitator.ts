import { Request } from 'express';
import { ZkpRepIdAttestation } from './repid-attestation';
import { db } from '../db';
import { ethers } from 'ethers';
import { resolveAndVerifyDomain } from './x402-outbound-client';
import { getActiveNetwork } from '../config/network';
import { x402Metrics } from '../observability/x402-metrics';
import { getProvider } from '../clients/rpc-with-failover';

// x402 protocol version advertised to clients and sent in the facilitator
// request envelope. Current protocol is v2 (coinbase/x402 specs, transports-v2).
export const X402_VERSION = 2;

// Default authorization validity window (seconds) the server expects for the
// `exact` scheme. Emitted as `maxTimeoutSeconds` so the buyer's EIP-3009
// `validBefore` window and the server's expectation agree (x402 PaymentRequirements
// field). 3600s matches trustshell's signing default.
export const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;

/**
 * One entry of a 402 challenge's `accepts`, carrying BOTH wire shapes.
 *
 * x402 v2 (coinbase/x402 `specs/x402-specification-v2.md` §5.1.2) names the price `amount` and
 * moves `resource` / `mimeType` / `description` up to a top-level `ResourceInfo` object. The v1
 * fields stay on each entry because the clients we ship (trustshell, `x402-outbound-client.ts`)
 * and the recovery worker read `maxAmountRequired`. Both price fields are always the same string;
 * `buildPaymentRequirements` is the only place either is set. `toV2Requirements` projects an entry
 * to the strict v2 shape for the `PAYMENT-REQUIRED` header.
 */
export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  /** v2 price, atomic units. Optional only so older hand-built requirement objects still type-check. */
  amount?: string;
  /** v1 price, atomic units. Same value as `amount`. */
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  mimeType: string;
  description?: string;
  // Authorization validity window in seconds (x402 spec field). The client
  // must produce an authorization whose validity does not exceed this.
  maxTimeoutSeconds: number;
  extra?: {
    name: string;
    version: string;
  };
}

export interface VerifyResult {
  valid: boolean;
  payer: string;
  reason?: string;
}

export interface SettleResult {
  success: boolean;
  txHash: string;
  network: string;
  payer: string;
}

// ---------------------------------------------------------------------------
// x402 v2 HTTP transport (coinbase/x402 `specs/transports-v2/http.md`).
//
// Until 2026-11-16 the challenge was a hybrid: body `x402Version: 2` with v1 entries
// (`maxAmountRequired`, per-entry `resource`), no `PAYMENT-REQUIRED` header, and only `X-PAYMENT`
// read on the retry. The official v2 client reads the header, found none, and could not pay.
// These helpers build the strict v2 object for the header and keep the body readable by v1 clients.
// ---------------------------------------------------------------------------

/** v2 `ResourceInfo` (spec §5.1.2). */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** v2 `PaymentRequirements` (spec §5.1.2): exactly the spec's fields, nothing from v1. */
export interface PaymentRequirementsV2 {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name: string; version: string };
}

/** v2 `PaymentRequired` (spec §5.1). */
export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirementsV2[];
}

/** v2 `SettlementResponse` (spec §5.3). */
export interface SettlementResponseV2 {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

/** Header names, as the v2 HTTP transport spells them. */
export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

/** Base64 of UTF-8 JSON: how every v2 header carries its object. */
export function encodeX402Header(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

/** Project one dual-shape entry to the strict v2 shape. The price is copied, never recomputed. */
export function toV2Requirements(r: PaymentRequirements): PaymentRequirementsV2 {
  const out: PaymentRequirementsV2 = {
    scheme: r.scheme,
    network: r.network,
    amount: r.amount ?? r.maxAmountRequired,
    asset: r.asset,
    payTo: r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
  };
  if (r.extra) out.extra = { name: r.extra.name, version: r.extra.version };
  return out;
}

/**
 * The strict v2 `PaymentRequired` for the `PAYMENT-REQUIRED` header. The top-level `resource` is
 * taken from the first entry, which is where `buildPaymentRequirements` puts it.
 */
export function buildPaymentRequired(requirements: PaymentRequirements[], error?: string): PaymentRequiredV2 {
  const first = requirements[0];
  const resource: ResourceInfo = { url: first?.resource ?? '' };
  if (first?.description) resource.description = first.description;
  if (first?.mimeType) resource.mimeType = first.mimeType;
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource,
    accepts: requirements.map(toV2Requirements),
  };
}

/**
 * A 402 challenge in both shapes: the `PAYMENT-REQUIRED` header value (strict v2, what the official
 * client reads) and a body that is the same v2 object except that `accepts` keeps the v1 fields
 * current clients read. `extraBody` carries route-specific fields such as `reason`.
 */
export function paymentRequiredResponse(
  requirements: PaymentRequirements[],
  error: string,
  extraBody: Record<string, unknown> = {},
): { header: string; body: Record<string, unknown> } {
  const v2 = buildPaymentRequired(requirements, error);
  return {
    header: encodeX402Header(v2),
    body: { ...v2, accepts: requirements, ...extraBody },
  };
}

export interface NormalizedPayment {
  /**
   * The header in the flat shape `verifyPayment` / `settlePayment` decode:
   * base64 JSON `{ from, to, value, validAfter, validBefore, nonce, signature }`. A flat or
   * unparseable header is passed through UNCHANGED, so every existing client reaches the
   * facilitator byte for byte as before.
   */
  header: string;
  /** `v2` / `v1` = an official x402 PaymentPayload; `flat` = what trustshell sends; `opaque` = not JSON. */
  shape: 'v2' | 'v1' | 'flat' | 'opaque';
  /** v2 only: the requirement the client says it accepted (spec §5.2, required). */
  accepted?: Record<string, unknown>;
}

/**
 * Accept the official x402 `PaymentPayload` (`{x402Version, accepted, payload:{signature,
 * authorization}}`, spec §5.2) as well as the flat shape our own clients send.
 *
 * This only re-reads WHERE the signature and authorization sit. Amount, payee, asset and network
 * still come from the server's own requirements in `buildV2Envelope`, never from the client, and the
 * facilitator still verifies the signature against them.
 */
export function normalizePaymentHeader(raw: string): NormalizedPayment {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { header: raw, shape: 'opaque' };
  }
  if (!decoded || typeof decoded !== 'object') return { header: raw, shape: 'opaque' };
  const d = decoded as Record<string, unknown>;
  const inner = d['payload'];
  if (inner && typeof inner === 'object') {
    const p = inner as Record<string, unknown>;
    if (p['signature'] !== undefined || p['authorization'] !== undefined) {
      const auth = (p['authorization'] && typeof p['authorization'] === 'object'
        ? p['authorization']
        : {}) as Record<string, unknown>;
      const flat = {
        from: auth['from'],
        to: auth['to'],
        value: auth['value'],
        validAfter: auth['validAfter'],
        validBefore: auth['validBefore'],
        nonce: auth['nonce'],
        signature: p['signature'],
      };
      const accepted = d['accepted'];
      return {
        header: encodeX402Header(flat),
        shape: d['x402Version'] === 2 ? 'v2' : 'v1',
        ...(accepted && typeof accepted === 'object' ? { accepted: accepted as Record<string, unknown> } : {}),
      };
    }
  }
  return { header: raw, shape: 'flat' };
}

/**
 * Does a v2 client's `accepted` name one of the requirements we advertised? The official server
 * middleware refuses a payload that matches none; so do we. Comparison is on the fields that decide
 * what is paid (scheme, network, amount, asset, payTo); addresses compare case-insensitively.
 */
export function acceptedMatches(
  accepted: Record<string, unknown> | undefined,
  requirements: PaymentRequirements[],
): boolean {
  if (!accepted) return false;
  const lc = (v: unknown) => String(v ?? '').toLowerCase();
  return requirements.some((r) => {
    const v2 = toV2Requirements(r);
    return (
      accepted['scheme'] === v2.scheme &&
      accepted['network'] === v2.network &&
      String(accepted['amount']) === v2.amount &&
      lc(accepted['asset']) === lc(v2.asset) &&
      lc(accepted['payTo']) === lc(v2.payTo)
    );
  });
}

export class X402Facilitator {
  buildPaymentRequirements(opts: {
    resource: string,
    payTo: string,
    priceUsdc: string,
    network?: string,
    description?: string,
    maxTimeoutSeconds?: number
  }): PaymentRequirements[] {
    const netConfig = getActiveNetwork();
    // EIP-712 domain the client signs against (v2 `exact`/eip3009 requires extra.name + version).
    // A config without one advertises no `extra` rather than a guessed domain: a wrong name makes
    // every signature fail, which is worse than a client that has to read name() itself.
    const domain = netConfig.contracts?.usdcEip712Domain;
    return [{
      scheme: "exact",
      network: netConfig.x402.networkParam,
      amount: opts.priceUsdc,
      maxAmountRequired: opts.priceUsdc,
      asset: netConfig.contracts.usdc,
      payTo: opts.payTo,
      resource: opts.resource,
      mimeType: "application/json",
      description: opts.description,
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
      ...(domain ? { extra: { name: domain.name, version: domain.version } } : {}),
    }];
  }

  /**
   * Build the x402 v2 facilitator request envelope for /verify and /settle.
   *
   * The public x402.org facilitator migrated to the v2 wire shape (verified
   * 2026-07-22 against the live /verify endpoint + specs/schemes/exact/
   * scheme_exact_evm.md). Differences from the v1 body we used to send:
   *   - requirements use `amount` (not `maxAmountRequired`); no top-level
   *     resource/mimeType/description
   *   - the PaymentPayload embeds the requirements as `accepted` and no longer
   *     carries top-level scheme/network (that omission was the live
   *     "Cannot read properties of undefined (reading 'scheme')" 500)
   *   - authorization numeric fields are strings
   *   - extra carries assetTransferMethod:"eip3009" + name/version
   */
  private buildV2Envelope(
    reqObj: PaymentRequirements,
    signature: string,
    auth: { from: string; to: string; value: unknown; validAfter: unknown; validBefore: unknown; nonce: string },
    tokenName: string,
    tokenVersion: string,
  ): Record<string, unknown> {
    const accepted = {
      scheme: reqObj.scheme,
      network: reqObj.network,
      amount: reqObj.maxAmountRequired,
      asset: reqObj.asset,
      payTo: reqObj.payTo,
      maxTimeoutSeconds: reqObj.maxTimeoutSeconds,
      extra: { assetTransferMethod: 'eip3009', name: tokenName, version: tokenVersion },
    };
    const authorization = {
      from: auth.from,
      to: auth.to,
      value: auth.value != null ? String(auth.value) : undefined,
      validAfter: auth.validAfter != null ? String(auth.validAfter) : '0',
      validBefore: auth.validBefore != null ? String(auth.validBefore) : undefined,
      nonce: auth.nonce,
    };
    return {
      x402Version: X402_VERSION,
      paymentPayload: {
        x402Version: X402_VERSION,
        accepted,
        payload: { signature: signature || '', authorization },
      },
      paymentRequirements: accepted,
    };
  }

  async verifyPayment(
    xPaymentHeader: string,
    requirements: PaymentRequirements | PaymentRequirements[]
  ): Promise<VerifyResult> {
    const startTime = Date.now();
    x402Metrics.increment('facilitator.verify.attempt');
    x402Metrics.increment('facilitator.verify.real');

    try {
      let paymentPayload: any;
      try {
        paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
      } catch (err) {
        paymentPayload = { txHash: xPaymentHeader };
      }

      const reqObj = Array.isArray(requirements) ? requirements[0] : requirements;
      if (!reqObj) {
        x402Metrics.increment('facilitator.verify.failure');
        x402Metrics.recordLatency('facilitator.verify', Date.now() - startTime);
        return { valid: false, payer: '', reason: 'Requirements must not be empty' };
      }

      let signature = paymentPayload.signature || paymentPayload.txHash;
      if (!signature && paymentPayload.r && paymentPayload.s && paymentPayload.v !== undefined) {
        try {
          signature = ethers.Signature.from({
            r: paymentPayload.r,
            s: paymentPayload.s,
            v: Number(paymentPayload.v)
          }).serialized;
        } catch (e) {
          // ignore
        }
      }

      const netConfig = getActiveNetwork();
      const chainId = netConfig.chainId;
      const provider = getProvider();

      let name = "USDC";
      let version = "2";
      try {
        const resolvedDomain = await resolveAndVerifyDomain(reqObj.asset, chainId, provider);
        name = resolvedDomain.name;
        version = resolvedDomain.version;
      } catch (err) {
        console.error(`[x402-facilitator] Error resolving domain for ${reqObj.asset}:`, err);
      }

      const response = await fetch(`${netConfig.x402.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          this.buildV2Envelope(reqObj, signature, paymentPayload, name, version),
        )
      });

      if (!response.ok) {
        const text = await response.text();
        x402Metrics.increment('facilitator.verify.failure');
        x402Metrics.recordLatency('facilitator.verify', Date.now() - startTime);
        return { valid: false, payer: '', reason: `Facilitator error: ${response.status} ${text}` };
      }

      const data = await response.json() as any;
      if (data.valid) {
        x402Metrics.increment('facilitator.verify.success');
      } else {
        x402Metrics.increment('facilitator.verify.failure');
      }
      x402Metrics.recordLatency('facilitator.verify', Date.now() - startTime);
      return {
        valid: data.valid !== undefined ? data.valid : data.isValid,
        payer: data.payer,
        reason: data.reason
      };
    } catch (e: any) {
      x402Metrics.increment('facilitator.verify.failure');
      x402Metrics.recordLatency('facilitator.verify', Date.now() - startTime);
      return { valid: false, payer: '', reason: e.message };
    }
  }

  async settlePayment(
    xPaymentHeader: string,
    requirements: PaymentRequirements | PaymentRequirements[]
  ): Promise<SettleResult> {
    const startTime = Date.now();
    x402Metrics.increment('facilitator.settle.attempt');
    x402Metrics.increment('facilitator.settle.real');

    try {
      let paymentPayload: any;
      try {
        paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
      } catch (err) {
        paymentPayload = { txHash: xPaymentHeader };
      }

      const reqObj = Array.isArray(requirements) ? requirements[0] : requirements;
      if (!reqObj) {
        x402Metrics.increment('facilitator.settle.failure');
        x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);
        throw new Error('Requirements must not be empty');
      }

      let signature = paymentPayload.signature || paymentPayload.txHash;
      if (!signature && paymentPayload.r && paymentPayload.s && paymentPayload.v !== undefined) {
        try {
          signature = ethers.Signature.from({
            r: paymentPayload.r,
            s: paymentPayload.s,
            v: Number(paymentPayload.v)
          }).serialized;
        } catch (e) {
          // ignore
        }
      }

      const netConfig = getActiveNetwork();
      const chainId = netConfig.chainId;
      const provider = getProvider();

      let name = "USDC";
      let version = "2";
      try {
        const resolvedDomain = await resolveAndVerifyDomain(reqObj.asset, chainId, provider);
        name = resolvedDomain.name;
        version = resolvedDomain.version;
      } catch (err) {
        console.error(`[x402-facilitator] Error resolving domain for ${reqObj.asset}:`, err);
      }

      const response = await fetch(`${netConfig.x402.facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          this.buildV2Envelope(reqObj, signature, paymentPayload, name, version),
        )
      });

      if (!response.ok) {
        const text = await response.text();
        x402Metrics.increment('facilitator.settle.failure');
        x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);
        throw new Error(`Facilitator error: ${response.status} ${text}`);
      }

      const data = await response.json() as any;
      if (!data.success) {
        x402Metrics.increment('facilitator.settle.failure');
        x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);
        throw new Error(data.errorMessage || data.errorReason || data.reason || 'Settlement failed');
      }

      x402Metrics.increment('facilitator.settle.success');
      x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);

      // v2 settle returns `transaction` (v1 was `txHash`); accept both.
      return {
        success: data.success,
        txHash: data.transaction ?? data.txHash,
        network: data.network,
        payer: data.payer
      };
    } catch (e: any) {
      x402Metrics.increment('facilitator.settle.failure');
      x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);
      throw new Error(`Settlement failed: ${e.message}`);
    }
  }

  async queueFailure(args: {
    direction: 'inbound' | 'outbound',
    agent_id: string,
    payment_payload_b64: string,
    payment_requirements: PaymentRequirements | PaymentRequirements[],
    facilitator_response?: any
  }): Promise<void> {
    await db.from('x402_settlement_failures').insert({
      direction: args.direction,
      agent_id: args.agent_id,
      payment_payload_b64: args.payment_payload_b64,
      payment_requirements: args.payment_requirements,
      facilitator_response: args.facilitator_response
    });
  }

  extractRepIdAttestation(req: Request): ZkpRepIdAttestation | null {
    const header = req.header('X-HYPERDAG-REPID-ATTESTATION');
    if (!header) return null;
    try {
      const decoded = Buffer.from(header, 'base64').toString('utf8');
      return JSON.parse(decoded) as ZkpRepIdAttestation;
    } catch (e) {
      return null;
    }
  }
}

export const x402Facilitator = new X402Facilitator();
