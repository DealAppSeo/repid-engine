import { repIdAttestationService, ZkpRepIdAttestation } from './repid-attestation';
import { db } from '../db';
import { ethers } from 'ethers';

import crypto from 'crypto';

export class X402OutboundClient {
  async get(url: string, opts: { agentId: string, providerAgentId: string, tipId: string, maxBudgetUsdc?: string }): Promise<{ data: any, txHash?: string, responseAttestation?: ZkpRepIdAttestation, idempotencyKey?: string }> {
    const maxBudget = opts.maxBudgetUsdc || "50000"; // 0.05 USDC (50,000 units of 6-decimal USDC)

    // 1. Generate HyperDAG agent's attestation
    const myAttestation = await repIdAttestationService.generateAttestation(opts.agentId);
    const myAttestationB64 = Buffer.from(JSON.stringify(myAttestation)).toString('base64');

    // 2. Initial call to the gated service
    let response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-HYPERDAG-REPID-ATTESTATION': myAttestationB64
      }
    });

    let txHash: string | undefined;
    let counterpartyAttestation: ZkpRepIdAttestation | undefined;
    let idempotencyKey: string | undefined;

    let offer: any;
    if (response.status === 402) {
      const body = await response.json() as any;
      const accepts = body.accepts as any[];
      offer = accepts.find((a: any) => a.network === 'base-sepolia' && a.scheme === 'exact');


      if (!offer) {
        throw new Error('No compatible x402 offer found (requires base-sepolia exact scheme)');
      }

      if (BigInt(offer.maxAmountRequired) > BigInt(maxBudget)) {
        throw new Error(`Price ${offer.maxAmountRequired} exceeds budget ${maxBudget}`);
      }

      // 3. Construct EIP-3009 signed payment
      const { data: agent } = await db.from('repid_agents').select('agent_name').eq('id', opts.agentId).single();
      const agentName = agent?.agent_name || '';
      const pk = process.env[`${agentName.toUpperCase()}_PRIVATE_KEY`];
      
      if (!pk) {
        throw new Error(`Private key for agent ${agentName} not found in env (${agentName.toUpperCase()}_PRIVATE_KEY)`);
      }

      const wallet = new ethers.Wallet(pk);

      // --- IDEMPOTENCY CHECK BEFORE NEW PAYMENT ---
      const hashInput = `${opts.agentId}:${opts.providerAgentId}:${opts.tipId}:${offer.maxAmountRequired}:${offer.asset}:${wallet.address}`;
      idempotencyKey = crypto.createHash('sha256').update(hashInput).digest('hex');

      const { data: existingSettlement } = await db.from('x402_settlements')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .single();

      if (existingSettlement) {
        if (existingSettlement.status === 'pending' || existingSettlement.status === 'confirmed' || existingSettlement.status === 'settled') {
          return { data: existingSettlement, txHash: existingSettlement.tx_hash, idempotencyKey };
        } else if (existingSettlement.status === 'failed') {
          await db.from('x402_settlements')
            .update({ settlement_attempt_count: existingSettlement.settlement_attempt_count + 1 })
            .eq('id', existingSettlement.id);
        }
      }
      
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity
      const value = BigInt(offer.maxAmountRequired);

      const domain = {
        name: "USD Coin",
        version: "2",
        chainId: 84532,
        verifyingContract: offer.asset
      };

      const types = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' }
        ]
      };

      const message = {
        from: wallet.address,
        to: offer.payTo,
        value: value,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonce
      };

      const signature = await wallet.signTypedData(domain, types, message);
      const sig = ethers.Signature.from(signature);

      const paymentPayload = {
        v: sig.v,
        r: sig.r,
        s: sig.s,
        from: wallet.address,
        to: offer.payTo,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: nonce
      };

      const paymentB64 = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

      // 4. Retry with X-PAYMENT header
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-PAYMENT': paymentB64,
          'X-HYPERDAG-REPID-ATTESTATION': myAttestationB64
        }
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`x402 request failed with status ${response.status}: ${text}`);
    }

    const data = await response.json();
    const xPaymentResponse = response.headers.get('X-PAYMENT-RESPONSE');
    if (xPaymentResponse) {
      try {
        const settleInfo = JSON.parse(xPaymentResponse);
        txHash = settleInfo.txHash;
      } catch (e) {
        console.warn('[X402OutboundClient] Failed to parse X-PAYMENT-RESPONSE header');
      }
    }

    const counterpartyAttestationB64 = response.headers.get('X-HYPERDAG-REPID-ATTESTATION');
    if (counterpartyAttestationB64) {
      try {
        counterpartyAttestation = JSON.parse(Buffer.from(counterpartyAttestationB64, 'base64').toString('utf8'));
        // Verify it (soft-fail on invalid attestation, just don't record it)
        const v = await repIdAttestationService.verifyAttestation(counterpartyAttestation!);
        if (!v.valid) {
          console.warn('[X402OutboundClient] Counterparty attestation invalid:', v.reason);
          counterpartyAttestation = undefined;
        }
      } catch (e) {
        console.warn('[X402OutboundClient] Failed to parse counterparty attestation');
      }
    }

    // 5. Write to repid_events
    await db.from('repid_events').insert({
      subject_id: opts.agentId,
      subject_type: 'agent',
      event_type: 'x402_outbound_settled',
      reputation_delta: 2, // Smaller positive delta for consuming value
      event_data: {
        tx_hash: txHash || null,
        recipient: url,
        amount: offer?.maxAmountRequired || '0',
        counterparty_attestation: counterpartyAttestation ? {
          agent_id: counterpartyAttestation.agent_id,
          repid: counterpartyAttestation.repid,
          tier: counterpartyAttestation.tier
        } : null,
        consumed_at: new Date().toISOString()
      }
    });


    return {
      data,
      txHash,
      responseAttestation: counterpartyAttestation,
      idempotencyKey
    };
  }
}

export const x402OutboundClient = new X402OutboundClient();
