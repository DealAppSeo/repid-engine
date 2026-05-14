import { ethers } from 'ethers';
import { DOMAIN, ANFIS_ROUTING_RECEIPT_TYPE, TRADE_ANALYSIS_RECEIPT_TYPE } from './eip712-schemas';
import { getSpokespersonWallet } from './signing-keys';

export class Eip712Signer {
  async signAnfisReceipt(spokespersonName: string, receipt: any): Promise<{ signature: string; signerAddress: string }> {
    const wallet = getSpokespersonWallet(spokespersonName);
    if (!wallet) {
      // Fallback to deployer if configured
      if (process.env.SIGNING_FALLBACK_MODE === 'deployer' && process.env.TRINITY_DEPLOYER_PRIVATE_KEY) {
        const fallback = new ethers.Wallet(process.env.TRINITY_DEPLOYER_PRIVATE_KEY);
        const signature = await fallback.signTypedData(DOMAIN, ANFIS_ROUTING_RECEIPT_TYPE, receipt);
        return { signature, signerAddress: fallback.address };
      }
      throw new Error(`No signing key for ${spokespersonName} and no fallback configured`);
    }
    const signature = await wallet.signTypedData(DOMAIN, ANFIS_ROUTING_RECEIPT_TYPE, receipt);
    return { signature, signerAddress: wallet.address };
  }

  async signTradeReceipt(spokespersonName: string, receipt: any): Promise<{ signature: string; signerAddress: string }> {
    const wallet = getSpokespersonWallet(spokespersonName);
    if (!wallet) {
      if (process.env.SIGNING_FALLBACK_MODE === 'deployer' && process.env.TRINITY_DEPLOYER_PRIVATE_KEY) {
        const fallback = new ethers.Wallet(process.env.TRINITY_DEPLOYER_PRIVATE_KEY);
        const signature = await fallback.signTypedData(DOMAIN, TRADE_ANALYSIS_RECEIPT_TYPE, receipt);
        return { signature, signerAddress: fallback.address };
      }
      throw new Error(`No signing key for ${spokespersonName} and no fallback configured`);
    }
    const signature = await wallet.signTypedData(DOMAIN, TRADE_ANALYSIS_RECEIPT_TYPE, receipt);
    return { signature, signerAddress: wallet.address };
  }
}

export const eip712Signer = new Eip712Signer();
