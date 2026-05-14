import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import bodyParser from 'body-parser';
import inboundRouter from '../src/routes/x402-inbound';
import { db } from '../src/db';
import { x402Facilitator } from '../src/services/x402-facilitator';

// Ensure mock mode
process.env.X402_FACILITATOR_MODE = 'mock';
x402Facilitator.verifyPayment = async () => ({ valid: true, payer: '0xmockpayer_recording_test' });
x402Facilitator.settlePayment = async () => ({ txHash: '0xmocktx_recording_test_' + Date.now() });

const app = express();
app.use(bodyParser.json());
app.use('/x402', inboundRouter);

async function main() {
  const server = app.listen(3008);
  const SHOFET_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';
  const url = `http://localhost:3008/x402/${SHOFET_UUID}/anfis-classify`;
  
  console.log('\n[smoke] Calling ANFIS endpoint to test dual-table write...');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': 'mock_payment_token' },
    body: JSON.stringify({ payload: 'Dual write recording test' })
  });
  
  const data: any = await res.json();
  const txHash = res.headers.get('X-PAYMENT-RESPONSE') ? JSON.parse(res.headers.get('X-PAYMENT-RESPONSE')!).txHash : null;

  if (!txHash) {
    console.error('TEST FAIL: dual-table write - No txHash returned');
    server.close();
    process.exit(1);
  }

  console.log(`[smoke] Got txHash: ${txHash}`);
  
  // Verify in x402_settlements
  const { data: settlementData, error: sErr } = await db
    .from('x402_settlements')
    .select('*')
    .eq('tip_id', `anfis:${txHash}`)
    .single();
    
  if (sErr || !settlementData) {
    console.error(`TEST FAIL: dual-table write - x402_settlements row not found. Error: ${sErr?.message}`);
    server.close();
    process.exit(1);
  }
  console.log(`[smoke] Verified x402_settlements write: tip_id = ${settlementData.tip_id}, amount = ${settlementData.amount}`);
  
  // Verify in repid_events
  const { data: repidData, error: rErr } = await db
    .from('repid_events')
    .select('*')
    .eq('event_type', 'x402_inbound_settled')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
    
  if (rErr || !repidData) {
    console.error(`TEST FAIL: dual-table write - repid_events row not found. Error: ${rErr?.message}`);
    server.close();
    process.exit(1);
  }
  
  if (repidData.event_data.tx_hash !== txHash) {
    console.error(`TEST FAIL: dual-table write - repid_events tx_hash mismatch. Got ${repidData.event_data.tx_hash}, expected ${txHash}`);
    server.close();
    process.exit(1);
  }
  console.log(`[smoke] Verified repid_events write: tx_hash matches.`);
  
  console.log('TEST PASS: x402 settlement dual-table recording');
  server.close();
}

main().catch(console.error);
