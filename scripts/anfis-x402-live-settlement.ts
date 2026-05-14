import * as dotenv from 'dotenv';
dotenv.config();
import { ethers } from 'ethers';
import { createX402Payment } from './create-x402-payload';

const SHOFET_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';
const SHOFET_ADDRESS = '0x15eB9A7427f1B54486926465d5895cD51eB8b052';
const SERVICE_URL = 'http://localhost:3000'; // Make sure the server is running

async function main() {
  console.log(`\n========== ANFIS x402 LIVE SETTLEMENT ==========\n`);

  const buyerKey = process.env.BUYER_PRIVATE_KEY || process.env.TRINITY_DEPLOYER_PRIVATE_KEY;
  if (!buyerKey) {
    console.error('Missing BUYER_PRIVATE_KEY in environment');
    process.exit(1);
  }

  const buyer = new ethers.Wallet(buyerKey);
  console.log('Buyer Address:', buyer.address);

  const url = `${SERVICE_URL}/x402/${SHOFET_UUID}/anfis-classify`;
  const prompt = 'Help me write code';

  console.log('\n1. Initial request (expecting 402)...');
  const res1 = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: prompt })
  });

  if (res1.status !== 402) {
    console.error(`✗ Expected 402, got ${res1.status}`);
    const text = await res1.text();
    console.error(text);
    process.exit(1);
  }

  const data1: any = await res1.json();
  const requirements = data1.accepts[0];
  console.log(`✓ Got 402 with requirements (price: ${requirements.maxAmountRequired})`);

  console.log('\n2. Creating EIP-3009 payment payload...');
  const amount = BigInt(requirements.maxAmountRequired);
  const paymentB64 = await createX402Payment(buyer, requirements.payTo, amount);

  console.log('\n3. Re-requesting with X-PAYMENT header...');
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
    process.exit(1);
  }

  const data2: any = await res2.json();
  console.log(`✓ Got 200 OK! Provider: ${data2.provider}, Reasoning: ${data2.reasoning}`);

  const txResponse = res2.headers.get('X-PAYMENT-RESPONSE');
  if (txResponse) {
    const tx = JSON.parse(txResponse);
    console.log(`✓ Settlement Hash: ${tx.txHash}`);
    if (tx.txHash && tx.txHash !== 'mock_tx_hash') {
      console.log(`  Basescan: https://sepolia.basescan.org/tx/${tx.txHash}`);
    }
  } else {
    console.log('⚠ No X-PAYMENT-RESPONSE header found.');
  }

  console.log('\nLive Settlement Loop Complete!');
}

main().catch(console.error);
