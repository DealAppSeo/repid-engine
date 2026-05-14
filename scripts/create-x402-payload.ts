import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';

const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 84532,
  verifyingContract: USDC_ADDRESS
};

const TRANSFER_TYPE = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

export async function createX402Payment(
  buyerWallet: ethers.Wallet,
  recipientAddress: string,
  amountUsdc: bigint  // amount in 6-decimal units
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: buyerWallet.address,
    to: recipientAddress,
    value: amountUsdc.toString(),
    validAfter: '0',
    validBefore: (now + 600).toString(),
    nonce: ethers.hexlify(ethers.randomBytes(32))
  };
  
  const signature = await buyerWallet.signTypedData(USDC_DOMAIN, TRANSFER_TYPE, authorization);
  const sig = ethers.Signature.from(signature);
  
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    payload: {
      signature: { v: sig.v, r: sig.r, s: sig.s },
      authorization
    }
  };
  
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// CLI test
if (require.main === module) {
  (async () => {
    const buyerKey = process.env.BUYER_PRIVATE_KEY || process.env.TRINITY_DEPLOYER_PRIVATE_KEY;
    if (!buyerKey) {
      console.error('BUYER_PRIVATE_KEY not set');
      process.exit(1);
    }
    
    const buyer = new ethers.Wallet(buyerKey);
    console.log('Buyer:', buyer.address);
    
    // Test: create a payment of 0.1 USDC to trinity-shofet
    const recipient = '0x15eB9A7427f1B54486926465d5895cD51eB8b052';
    const amount = BigInt(100000); // 0.1 USDC (6 decimals)
    
    const payload = await createX402Payment(buyer, recipient, amount);
    console.log('Payload:', payload);
    console.log('\nUse this as X-PAYMENT header value.');
  })();
}
