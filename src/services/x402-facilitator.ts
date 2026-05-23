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

interface CircuitBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF-OPEN';
  consecutiveFailures: number;
  lastFailureTime: number;
}

export class X402Facilitator {
  private breaker: CircuitBreakerState = {
    state: 'CLOSED',
    consecutiveFailures: 0,
    lastFailureTime: 0
  };
  private readonly threshold = 3;
  private readonly cooldownMs = 10000; // 10 seconds

  getBreakerState(): CircuitBreakerState {
    return this.breaker;
  }

  resetBreaker(): void {
    this.breaker = {
      state: 'CLOSED',
      consecutiveFailures: 0,
      lastFailureTime: 0
    };
  }

  private checkBreaker(): void {
    if (this.breaker.state === 'OPEN') {
      if (Date.now() - this.breaker.lastFailureTime > this.cooldownMs) {
        this.breaker.state = 'HALF-OPEN';
      } else {
        throw new Error('FACILITATOR_CIRCUIT_BREAKER_OPEN');
      }
    }
  }

  private recordSuccess(): void {
    this.breaker.state = 'CLOSED';
    this.breaker.consecutiveFailures = 0;
  }

  private recordFailure(): void {
    this.breaker.consecutiveFailures++;
    if (this.breaker.consecutiveFailures >= this.threshold) {
      this.breaker.state = 'OPEN';
      this.breaker.lastFailureTime = Date.now();
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>, attempt = 1): Promise<T> {
    this.checkBreaker();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (e: any) {
      this.recordFailure();
      if (this.breaker.state === 'OPEN') {
        throw e;
      }
      if (attempt >= 3) {
        throw e;
      }
      const backoff = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, backoff));
      return this.executeWithRetry(fn, attempt + 1);
    }
  }

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
      return await this.executeWithRetry(async () => {
        const paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
        const url = process.env.X402_FACILITATOR_URL || FACILITATOR_URL;

        const response = await fetch(`${url}/verify`, {
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
        return {
          valid: data.valid,
          payer: data.payer,
          reason: data.reason
        };
      });
    } catch (e: any) {
      return { valid: false, payer: '', reason: e.message };
    }
  }

  async settlePayment(xPaymentHeader: string, requirements: PaymentRequirements[]): Promise<SettleResult> {
    return this.executeWithRetry(async () => {
      const paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
      const url = process.env.X402_FACILITATOR_URL || FACILITATOR_URL;

      const response = await fetch(`${url}/settle`, {
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
    });
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
