import { Request } from 'express';
import { ZkpRepIdAttestation } from './repid-attestation';
import { db } from '../db';

export interface PaymentRequirements {
  scheme: 'exact';
  network: 'base-sepolia';
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  mimeType: string;
  description?: string;
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

const FACILITATOR_URL = "https://x402.org/facilitator";
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export class X402Facilitator {
  buildPaymentRequirements(opts: {
    resource: string,
    payTo: string,
    priceUsdc: string,
    network: "base-sepolia",
    description?: string
  }): PaymentRequirements[] {
    return [{
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: opts.priceUsdc,
      asset: USDC_BASE_SEPOLIA,
      payTo: opts.payTo,
      resource: opts.resource,
      mimeType: "application/json",
      description: opts.description
    }];
  }

  async verifyPayment(xPaymentHeader: string, requirements: PaymentRequirements[]): Promise<VerifyResult> {
    try {
      const paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));

      const response = await fetch(`${FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: requirements
        })
      });

      if (!response.ok) {
        const text = await response.text();
        return { valid: false, payer: '', reason: `Facilitator error: ${response.status} ${text}` };
      }

      const data = await response.json() as any;
      return {
        valid: data.valid,
        payer: data.payer,
        reason: data.reason
      };
    } catch (e: any) {
      return { valid: false, payer: '', reason: e.message };
    }
  }

  async settlePayment(xPaymentHeader: string, requirements: PaymentRequirements[]): Promise<SettleResult> {
    try {
      const paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));

      const response = await fetch(`${FACILITATOR_URL}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload,
          paymentRequirements: requirements
        })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Facilitator error: ${response.status} ${text}`);
      }

      const data = await response.json() as any;
      if (!data.success) {
        throw new Error(data.reason || 'Settlement failed');
      }

      return {
        success: data.success,
        txHash: data.txHash,
        network: data.network,
        payer: data.payer
      };
    } catch (e: any) {
      throw new Error(`Settlement failed: ${e.message}`);
    }
  }

  async queueFailure(args: {
    direction: 'inbound' | 'outbound',
    agent_id: string,
    payment_payload_b64: string,
    payment_requirements: PaymentRequirements[],
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
