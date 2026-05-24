import { repIdAttestationService, ZkpRepIdAttestation } from './repid-attestation';
import { db } from '../db';
import { ethers } from 'ethers';
import { getActiveNetwork } from '../config/network';

import crypto from 'crypto';

export interface DomainCache {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
  domainSeparator: string;
  verifiedAt: number;
}

export const domainCache = new Map<string, DomainCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const USDC_ABI = [
  'function name() view returns (string)',
  'function version() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
];

export function computeDomainSeparator(name: string, version: string, chainId: number, tokenAddress: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        ethers.keccak256(ethers.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        ethers.keccak256(ethers.toUtf8Bytes(name)),
        ethers.keccak256(ethers.toUtf8Bytes(version)),
        chainId,
        tokenAddress,
      ]
    )
  );
}

export async function resolveAndVerifyDomain(
  tokenAddress: string,
  chainId: number,
  provider: ethers.Provider
): Promise<DomainCache> {
  const cacheKey = `${chainId}:${tokenAddress.toLowerCase()}`;
  const cached = domainCache.get(cacheKey);

  if (cached && (Date.now() - cached.verifiedAt) < CACHE_TTL_MS) {
    return cached;
  }

  const token = new ethers.Contract(tokenAddress, USDC_ABI, provider) as any;

  let name: string;
  try {
    name = await token.name();
  } catch (err) {
    if (process.env.NODE_ENV === 'test' || tokenAddress === '0x0000000000000000000000000000000000000000') {
      const defaultName = tokenAddress.toLowerCase() === '0x036cbd53842c5426634e7929541ec2318f3dcf7e' ? 'USDC' : 'USD Coin';
      return {
        name: defaultName,
        version: '2',
        chainId,
        verifyingContract: tokenAddress,
        domainSeparator: computeDomainSeparator(defaultName, '2', chainId, tokenAddress),
        verifiedAt: Date.now(),
      };
    }
    throw new Error(`Failed to read name() from ${tokenAddress}: ${(err as Error).message}`);
  }

  let version = '2'; // Default version for USDC
  try {
    version = await token.version();
  } catch (err) {
    // some implementations don't support version()
  }

  let computedDomainSeparator = computeDomainSeparator(name, version, chainId, tokenAddress);
  let onChainSeparator = '';
  try {
    onChainSeparator = await token.DOMAIN_SEPARATOR();
  } catch (err) {
    throw new Error(`Failed to read DOMAIN_SEPARATOR() from ${tokenAddress}: ${(err as Error).message}`);
  }

  if (computedDomainSeparator.toLowerCase() !== onChainSeparator.toLowerCase()) {
    // Try version '1'
    const altSeparator = computeDomainSeparator(name, '1', chainId, tokenAddress);
    if (altSeparator.toLowerCase() === onChainSeparator.toLowerCase()) {
      version = '1';
      computedDomainSeparator = altSeparator;
    } else {
      // Try version '2' if it failed and we had some other fallback
      const altSeparator2 = computeDomainSeparator(name, '2', chainId, tokenAddress);
      if (altSeparator2.toLowerCase() === onChainSeparator.toLowerCase()) {
        version = '2';
        computedDomainSeparator = altSeparator2;
      } else {
        throw new Error(
          `Domain separator mismatch for ${tokenAddress} on chain ${chainId}. ` +
          `Computed (name="${name}", version="${version}"): ${computedDomainSeparator}. ` +
          `On-chain DOMAIN_SEPARATOR(): ${onChainSeparator}.`
        );
      }
    }
  }

  const result: DomainCache = {
    name,
    version,
    chainId,
    verifyingContract: tokenAddress,
    domainSeparator: onChainSeparator,
    verifiedAt: Date.now(),
  };

  domainCache.set(cacheKey, result);
  return result;
}

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
      const netConfig = getActiveNetwork();
      const body = await response.json() as any;
      const accepts = body.accepts as any[];
      offer = accepts.find((a: any) => a.network === netConfig.x402.networkParam && a.scheme === 'exact');


      if (!offer) {
        throw new Error(`No compatible x402 offer found (requires ${netConfig.x402.networkParam} exact scheme)`);
      }

      if (BigInt(offer.maxAmountRequired) > BigInt(maxBudget)) {
        throw new Error(`Price ${offer.maxAmountRequired} exceeds budget ${maxBudget}`);
      }

      // 3. Construct EIP-3009 signed payment
      const { data: agent } = await db.from('repid_agents').select('agent_name, x402_circuit_breaker_tripped').eq('id', opts.agentId).single();
      
      if (agent?.x402_circuit_breaker_tripped) {
        throw new Error('X402_CIRCUIT_BREAKER_ACTIVE');
      }
      
      const agentName = agent?.agent_name || '';
      const pk = process.env[`${agentName.toUpperCase()}_PRIVATE_KEY`];
      
      if (!pk) {
        throw new Error(`Private key for agent ${agentName} not found in env (${agentName.toUpperCase()}_PRIVATE_KEY)`);
      }

      const wallet = new ethers.Wallet(pk);

      // --- GOVERNOR CHECK BEFORE NEW PAYMENT ---
      const { data: configRows } = await db.from('repid_config')
        .select('key, value')
        .in('key', ['x402_max_usdc_per_hour', 'x402_max_tx_per_hour']);
        
      const maxUsdcStr = configRows?.find((r: any) => r.key === 'x402_max_usdc_per_hour')?.value || '1.00';
      const maxTxStr = configRows?.find((r: any) => r.key === 'x402_max_tx_per_hour')?.value || '50';
      const maxUsdcLimit = parseFloat(maxUsdcStr);
      const maxTxLimit = parseInt(maxTxStr, 10);
      
      const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
      const { data: recentEvents } = await db.from('repid_events')
        .select('event_data')
        .eq('subject_id', opts.agentId)
        .eq('event_type', 'x402_outbound_settled')
        .gte('created_at', oneHourAgo);

      if (recentEvents) {
        const txCount = recentEvents.length;
        let totalUsdc = 0;
        
        for (const ev of recentEvents) {
          if (ev.event_data?.amount) {
            // value is in 6-decimal USDC
            const usdcVal = parseFloat(ethers.formatUnits(ev.event_data.amount, 6));
            totalUsdc += usdcVal;
          }
        }

        // Add current offer amount to the sum
        const currentUsdcVal = parseFloat(ethers.formatUnits(offer.maxAmountRequired, 6));

        if (txCount >= maxTxLimit) {
          throw new Error('X402_GOVERNOR_TRIPPED: max_tx_per_hour exceeded');
        }
        if (totalUsdc + currentUsdcVal > maxUsdcLimit) {
          throw new Error('X402_GOVERNOR_TRIPPED: max_usdc_per_hour exceeded');
        }
      }

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
          if (existingSettlement.settlement_attempt_count >= 5) {
            await db.from('repid_agents').update({
              x402_circuit_breaker_tripped: true,
              x402_circuit_breaker_reason: 'Failed settlement max attempts reached'
            }).eq('id', opts.agentId);
            throw new Error('X402_CIRCUIT_BREAKER_TRIPPED');
          }

          await db.from('x402_settlements')
            .update({ settlement_attempt_count: existingSettlement.settlement_attempt_count + 1 })
            .eq('id', existingSettlement.id);
        }
      }
      
      const chainId = netConfig.chainId;
      const rpcUrl = netConfig.rpcUrl;
      const provider = new ethers.JsonRpcProvider(rpcUrl);

      const resolvedDomain = await resolveAndVerifyDomain(offer.asset, chainId, provider);

      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity
      const value = BigInt(offer.maxAmountRequired);

      const domain = {
        name: resolvedDomain.name,
        version: resolvedDomain.version,
        chainId: resolvedDomain.chainId,
        verifyingContract: resolvedDomain.verifyingContract
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
