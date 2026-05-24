import { Request } from 'express';
import { ZkpRepIdAttestation } from './repid-attestation';
import { db } from '../db';
import { ethers } from 'ethers';
import { resolveAndVerifyDomain } from './x402-outbound-client';
import { getActiveNetwork } from '../config/network';
import { x402Metrics } from '../observability/x402-metrics';

export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  mimeType: string;
  description?: string;
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

export class X402Facilitator {
  buildPaymentRequirements(opts: {
    resource: string,
    payTo: string,
    priceUsdc: string,
    network?: string,
    description?: string
  }): PaymentRequirements[] {
    const netConfig = getActiveNetwork();
    return [{
      scheme: "exact",
      network: netConfig.x402.networkParam,
      maxAmountRequired: opts.priceUsdc,
      asset: netConfig.contracts.usdc,
      payTo: opts.payTo,
      resource: opts.resource,
      mimeType: "application/json",
      description: opts.description
    }];
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
      const rpcUrl = netConfig.rpcUrl;
      const provider = new ethers.JsonRpcProvider(rpcUrl);

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
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            x402Version: 1,
            scheme: reqObj.scheme,
            network: reqObj.network,
            payload: {
              signature: signature || '',
              authorization: {
                from: paymentPayload.from,
                to: paymentPayload.to,
                value: paymentPayload.value ? paymentPayload.value.toString() : undefined,
                validAfter: paymentPayload.validAfter !== undefined ? Number(paymentPayload.validAfter) : undefined,
                validBefore: paymentPayload.validBefore !== undefined ? Number(paymentPayload.validBefore) : undefined,
                nonce: paymentPayload.nonce
              }
            }
          },
          paymentRequirements: {
            ...reqObj,
            extra: {
              name,
              version
            }
          }
        })
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
      const rpcUrl = netConfig.rpcUrl;
      const provider = new ethers.JsonRpcProvider(rpcUrl);

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
        body: JSON.stringify({
          x402Version: 1,
          paymentPayload: {
            x402Version: 1,
            scheme: reqObj.scheme,
            network: reqObj.network,
            payload: {
              signature: signature || '',
              authorization: {
                from: paymentPayload.from,
                to: paymentPayload.to,
                value: paymentPayload.value ? paymentPayload.value.toString() : undefined,
                validAfter: paymentPayload.validAfter !== undefined ? Number(paymentPayload.validAfter) : undefined,
                validBefore: paymentPayload.validBefore !== undefined ? Number(paymentPayload.validBefore) : undefined,
                nonce: paymentPayload.nonce
              }
            }
          },
          paymentRequirements: {
            ...reqObj,
            extra: {
              name,
              version
            }
          }
        })
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
        throw new Error(data.reason || 'Settlement failed');
      }

      x402Metrics.increment('facilitator.settle.success');
      x402Metrics.recordLatency('facilitator.settle', Date.now() - startTime);

      return {
        success: data.success,
        txHash: data.txHash,
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
