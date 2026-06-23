import * as dotenv from 'dotenv';
import { settleX402Payment } from '../src/services/x402-real-settler';

dotenv.config();

async function main() {
  const confirmSend = process.env.CONFIRM_REAL_SEND === '1';

  console.log("==========================================================");
  console.log(`SINGLE X402 SETTLEMENT RUNNER (SOPHIA -> MEL)`);
  console.log(`CONFIRM_REAL_SEND: ${process.env.CONFIRM_REAL_SEND}`);
  console.log(`Execution Mode: ${confirmSend ? 'LIVE BROADCAST (REAL SEND)' : 'DRY-RUN (SIMULATED)'}`);
  console.log("==========================================================");

  const from = 'trinity-sophia';
  const to = 'trinity-mel';
  const amount = 0.05;
  const vertical = 'content';
  const key = `x402_single_sophia_mel_${Date.now()}`;

  console.log(`Processing: ${from} -> ${to} (${vertical})`);
  console.log(`Amount: ${amount} USDC`);
  console.log(`Idempotency Key: ${key}`);

  try {
    const result = await settleX402Payment(from, to, amount, key, vertical);
    if (result.tx_hash) {
      console.log(`SUCCESS! Tx Hash: ${result.tx_hash}`);
      console.log(`Basescan Link: ${result.basescan_url}`);
      console.log(`Settlement Source: ${result.settlement_source}`);
    } else {
      console.log(`DEFERRED/FAILED: ${result.error || 'insufficient balance/funding'}`);
    }
  } catch (err: any) {
    console.error(`ERROR running settlement:`, err.message);
  }

  console.log("==========================================================");
}

main().catch(console.error);
