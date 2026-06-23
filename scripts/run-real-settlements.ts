import * as dotenv from 'dotenv';
import { settleX402Payment } from '../src/services/x402-real-settler';

dotenv.config();

const BATCH_PAIRS = [
  {
    from: 'trinity-sophia',
    to: 'trinity-mel',
    amount: 0.05,
    vertical: 'content',
    key: `x402_val_lane_sophia_mel_${Date.now()}`
  },
  {
    from: 'trinity-veritas',
    to: 'trinity-torch',
    amount: 0.05,
    vertical: 'finance',
    key: `x402_val_lane_veritas_torch_${Date.now()}`
  },
  {
    from: 'trinity-gcm',
    to: 'trinity-apm',
    amount: 0.05,
    vertical: 'medical',
    key: `x402_val_lane_gcm_apm_${Date.now()}`
  },
  {
    from: 'trinity-nexus',
    to: 'trinity-hdm',
    amount: 0.05,
    vertical: 'trading',
    key: `x402_val_lane_nexus_hdm_${Date.now()}`
  }
];

async function main() {
  const confirmSend = process.env.CONFIRM_REAL_SEND === '1';

  console.log("==========================================================");
  console.log(`X402 BATCH SETTLEMENTS RUNNER`);
  console.log(`CONFIRM_REAL_SEND: ${process.env.CONFIRM_REAL_SEND}`);
  console.log(`Execution Mode: ${confirmSend ? 'LIVE BROADCAST (REAL SEND)' : 'DRY-RUN (SIMULATED)'}`);
  console.log("==========================================================");

  for (const pair of BATCH_PAIRS) {
    console.log(`\nProcessing: ${pair.from} -> ${pair.to} (${pair.vertical})`);
    console.log(`Amount: ${pair.amount} USDC`);
    console.log(`Idempotency Key: ${pair.key}`);

    try {
      const result = await settleX402Payment(pair.from, pair.to, pair.amount, pair.key, pair.vertical);
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
  }

  console.log("\n==========================================================");
  console.log("Batch runner run completed.");
  console.log("==========================================================");
}

main().catch(console.error);
