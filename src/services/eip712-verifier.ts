import { ethers } from 'ethers';
import { DOMAIN, ANFIS_ROUTING_RECEIPT_TYPE, TRADE_ANALYSIS_RECEIPT_TYPE } from './eip712-schemas';
import { db } from '../db';

export class Eip712Verifier {
  async verifyAnfisReceipt(
    receipt: any,
    signature: string
  ): Promise<{ valid: boolean; signerAddress?: string; reason?: string }> {
    try {
      const recovered = ethers.verifyTypedData(DOMAIN, ANFIS_ROUTING_RECEIPT_TYPE, receipt, signature);
      
      // Check signer matches a known spokesperson signing_address in DB
      const { data: agent } = await db
        .from('repid_agents')
        .select('agent_name, signing_address')
        .ilike('signing_address', recovered)
        .eq('squad_role', 'spokesperson')
        .maybeSingle();
      
      if (!agent) {
        // Check deployer fallback
        const deployerAddr = process.env.DEPLOYER_WALLET_ADDRESS || '0xdf6b8215D193b11B4903d223729c3CF7A6de271d';
        if (recovered.toLowerCase() === deployerAddr.toLowerCase()) {
          return { valid: true, signerAddress: recovered, reason: 'signed by deployer fallback' };
        }
        return { valid: false, signerAddress: recovered, reason: 'signer not a known spokesperson' };
      }
      
      // Check timestamp freshness (5 min window)
      const now = Math.floor(Date.now() / 1000);
      const ts = Number(receipt.timestamp);
      if (now - ts > 300) {
        return { valid: false, signerAddress: recovered, reason: `timestamp too old: ${now - ts}s` };
      }
      
      return { valid: true, signerAddress: recovered };
    } catch (e: any) {
      return { valid: false, reason: `verification error: ${e.message}` };
    }
  }
}

export const eip712Verifier = new Eip712Verifier();
