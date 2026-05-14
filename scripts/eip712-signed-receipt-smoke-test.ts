import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import bodyParser from 'body-parser';
import inboundRouter from '../src/routes/x402-inbound';
import { eip712Verifier } from '../src/services/eip712-verifier';
import { x402Facilitator } from '../src/services/x402-facilitator';
import { ethers } from 'ethers';

// Mock facilitator
x402Facilitator.verifyPayment = async () => ({ valid: true, payer: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d' });
x402Facilitator.settlePayment = async () => ({ txHash: '0xmocktx' });

// Inject mock env for the test
const mockWallet = ethers.Wallet.createRandom();
process.env.SIGNING_FALLBACK_MODE = 'deployer';
process.env.TRINITY_DEPLOYER_PRIVATE_KEY = mockWallet.privateKey;
process.env.DEPLOYER_WALLET_ADDRESS = mockWallet.address;

const app = express();
app.use(bodyParser.json());
app.use('/x402', inboundRouter);

async function main() {
  const server = app.listen(3006);
  
  // Get trinity-shofet's uuid from DB
  const SHOFET_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';
  const url = `http://localhost:3006/x402/${SHOFET_UUID}/anfis-classify`;
  
  console.log('\n[smoke] Calling ANFIS endpoint with x402 payment...');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': 'mock_payment' },
    body: JSON.stringify({ payload: 'Help me write some code' })
  });
  
  const data: any = await res.json();
  console.log('[smoke] Response:', JSON.stringify(data, null, 2));
  
  if (!data.signedReceipt) {
    console.error('[smoke] FAIL: No signedReceipt in response');
    server.close();
    process.exit(1);
  }
  
  console.log('\n[smoke] Verifying receipt signature...');
  const verifyResult = await eip712Verifier.verifyAnfisReceipt(
    data.signedReceipt.receipt,
    data.signedReceipt.signature
  );
  
  console.log('[smoke] Verification result:', verifyResult);
  
  if (verifyResult.valid) {
    console.log('[smoke] ✅ PASS — signed receipt verified, signer:', verifyResult.signerAddress);
  } else {
    console.log('[smoke] ❌ FAIL —', verifyResult.reason);
  }
  
  server.close();
}

main().catch(console.error);
