import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import bodyParser from 'body-parser';
import { ethers } from 'ethers';
import inboundRouter from '../src/routes/x402-inbound';
import { eip712Verifier } from '../src/services/eip712-verifier';
import { x402Facilitator } from '../src/services/x402-facilitator';
import { createX402Payment } from './create-x402-payload';

// Mock facilitator and keys to simulate A2A flow locally without real base-sepolia USDC dependencies
x402Facilitator.verifyPayment = async () => ({ valid: true, payer: '0xceD17F65E03e7b3a77D5321A2d3715840317199C' });
x402Facilitator.settlePayment = async () => ({ txHash: '0x00000000000000000000000000000000000000000000000000000000a2atx001' });

// Setup mock keys
const apmWallet = ethers.Wallet.createRandom(); // buyer
const mockDeployerWallet = ethers.Wallet.createRandom(); // acts as the signing fallback

process.env.SIGNING_FALLBACK_MODE = 'deployer';
process.env.TRINITY_DEPLOYER_PRIVATE_KEY = mockDeployerWallet.privateKey;
process.env.DEPLOYER_WALLET_ADDRESS = mockDeployerWallet.address;

const app = express();
app.use(bodyParser.json());
app.use('/x402', inboundRouter);

async function main() {
  console.log(`\n======================================================`);
  console.log(`   ANFIS x402 AGENT-TO-AGENT (A2A) SETTLEMENT DEMO    `);
  console.log(`======================================================\n`);

  console.log(`[A2A] Setting up identities...`);
  console.log(`  - Buyer: trinity-apm (Mock: ${apmWallet.address})`);
  console.log(`  - Provider: trinity-shofet`);
  
  const server = app.listen(3007);
  const SHOFET_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';
  const url = `http://localhost:3007/x402/${SHOFET_UUID}/anfis-classify`;
  const prompt = 'Please audit this smart contract according to RepID laws';
  
  console.log(`\n[A2A] Step 1: trinity-apm requests service from trinity-shofet...`);
  const res1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: prompt })
  });

  if (res1.status !== 402) {
    console.error(`✗ Expected 402, got ${res1.status}`);
    server.close();
    process.exit(1);
  }

  const data1: any = await res1.json();
  const requirements = data1.accepts[0];
  console.log(`  ✓ Received 402 Payment Required`);
  console.log(`  ✓ Required asset: USDC (${requirements.asset})`);
  console.log(`  ✓ Amount: ${requirements.maxAmountRequired} (0.1 USDC)`);

  console.log(`\n[A2A] Step 2: trinity-apm signs EIP-3009 transfer authorization...`);
  const amount = BigInt(requirements.maxAmountRequired);
  const paymentB64 = await createX402Payment(apmWallet, requirements.payTo, amount);
  console.log(`  ✓ Generated X-PAYMENT token`);

  console.log(`\n[A2A] Step 3: trinity-apm re-requests with X-PAYMENT header...`);
  const res2 = await fetch(url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-PAYMENT': paymentB64
    },
    body: JSON.stringify({ payload: prompt })
  });

  if (res2.status !== 200) {
    console.error(`✗ Expected 200, got ${res2.status}`);
    const text = await res2.text();
    console.error(text);
    server.close();
    process.exit(1);
  }

  const data2: any = await res2.json();
  console.log(`  ✓ 200 OK! Provider: ${data2.provider}, Confidence: ${data2.confidence}`);
  
  const txResponse = res2.headers.get('X-PAYMENT-RESPONSE');
  if (txResponse) {
    const tx = JSON.parse(txResponse);
    console.log(`  ✓ Settlement Complete. TX Hash: ${tx.txHash}`);
  }

  console.log(`\n[A2A] Step 4: trinity-apm verifies the EIP-712 signed receipt...`);
  if (!data2.signedReceipt) {
    console.error(`  ✗ Missing signed receipt`);
  } else {
    const verifyResult = await eip712Verifier.verifyAnfisReceipt(
      data2.signedReceipt.receipt,
      data2.signedReceipt.signature
    );
    
    if (verifyResult.valid) {
      console.log(`  ✓ Receipt Signature VERIFIED. Signer: ${verifyResult.signerAddress}`);
      console.log(`  ✓ Receipt guarantees:`);
      console.log(`      Prompt Hash: ${data2.signedReceipt.receipt.promptHash.substring(0,20)}...`);
      console.log(`      Settled for: 0.1 USDC`);
    } else {
      console.log(`  ✗ Receipt Verification FAILED: ${verifyResult.reason}`);
    }
  }

  console.log(`\n======================================================`);
  console.log(`           A2A DEMO SUCCESSFULLY COMPLETED            `);
  console.log(`======================================================\n`);
  
  server.close();
}

main().catch(console.error);
