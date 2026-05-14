import { ethers } from 'ethers';

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const USDC_ADDRESS_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

export class X402Facilitator {
  buildPaymentRequirements({ resource, payTo, priceUsdc, network, description }: any) {
    return [{
      scheme: 'exact',
      network,
      maxAmountRequired: priceUsdc,
      resource,
      description,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 60,
      asset: USDC_ADDRESS_BASE_SEPOLIA,
      extra: {
        name: 'USDC',
        version: '2'
      }
    }];
  }

  async verifyPayment(xPaymentHeader: string, requirements: any[]): Promise<{ valid: boolean; payer?: string; reason?: string }> {
    if (process.env.X402_FACILITATOR_MODE !== 'real') {
      // Mock mode
      return { valid: true, payer: '0xmockpayer' };
    }
    
    try {
      const res = await fetch(`${FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          paymentPayload: xPaymentHeader,
          paymentRequirements: requirements[0]
        })
      });
      
      if (!res.ok) {
        const text = await res.text();
        return { valid: false, reason: `facilitator returned ${res.status}: ${text}` };
      }
      
      const data: any = await res.json();
      return { valid: data.isValid, payer: data.payer, reason: data.invalidReason };
    } catch (e: any) {
      return { valid: false, reason: `facilitator error: ${e.message}` };
    }
  }

  async settlePayment(xPaymentHeader: string, requirements: any[]): Promise<{ txHash: string }> {
    if (process.env.X402_FACILITATOR_MODE !== 'real') {
      return { txHash: 'mock_settle_tx' };
    }
    
    const res = await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        paymentPayload: xPaymentHeader,
        paymentRequirements: requirements[0]
      })
    });
    
    if (!res.ok) {
      throw new Error(`facilitator settle failed: ${res.status}`);
    }
    
    const data: any = await res.json();
    return { txHash: data.txHash };
  }

  // Preserve other methods if there were any
  extractRepIdAttestation(req: any) {
    const attestationB64 = req.header('X-HYPERDAG-REPID-ATTESTATION');
    if (attestationB64) {
      try {
        return JSON.parse(Buffer.from(attestationB64, 'base64').toString('utf8'));
      } catch (e) {
        console.warn('Failed to parse attestation header');
      }
    }
    return null;
  }

  async queueFailure(params: any) {
    const { db } = require('../db');
    await db.from('x402_settlement_failures').insert([params]);
  }
}

export const x402Facilitator = new X402Facilitator();
