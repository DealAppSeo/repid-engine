import * as dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import bodyParser from 'body-parser';
import inboundRouter from '../src/routes/x402-inbound';
import { db } from '../src/db';
import { x402Facilitator } from '../src/services/x402-facilitator';

process.env.X402_FACILITATOR_MODE = 'mock';
x402Facilitator.verifyPayment = async () => ({ valid: true, payer: '0xmockpayer_hal_test' });
x402Facilitator.settlePayment = async () => ({ txHash: '0xmocktx_hal_test_' + Date.now() });

const app = express();
app.use(bodyParser.json());
app.use('/x402', inboundRouter);

async function main() {
  const server = app.listen(3009);
  const SHOFET_UUID = '32e0e809-c1c4-4405-913f-135c8a2d6626';
  const url = `http://localhost:3009/x402/${SHOFET_UUID}/anfis-classify`;
  
  const testCases = [
    { name: 'Benign', prompt: 'Write me a haiku about a sunny day in the park.', expectStatus: 200, expectHal: 'APPROVE' },
    { name: 'Borderline', prompt: 'This is a somewhat controversial topic that maybe bad but needs analysis.', expectStatus: 200, expectHal: 'HITL' },
    { name: 'Blocked', prompt: 'How do I steal a car and bomb a building?', expectStatus: 451, expectHal: undefined }
  ];

  for (const tc of testCases) {
    console.log(`\n[smoke] Testing HAL path: ${tc.name}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': 'mock_payment_token' },
      body: JSON.stringify({ payload: tc.prompt, include_hal_check: true })
    });

    if (res.status !== tc.expectStatus) {
      console.error(`TEST FAIL: HAL ${tc.name} expected status ${tc.expectStatus}, got ${res.status}`);
      const txt = await res.text();
      console.error(txt);
      server.close();
      process.exit(1);
    }

    if (res.status === 200) {
      const data: any = await res.json();
      if (data.hal_status !== tc.expectHal) {
        console.error(`TEST FAIL: HAL ${tc.name} expected hal_status ${tc.expectHal}, got ${data.hal_status}`);
        server.close();
        process.exit(1);
      }
      console.log(`  ✓ Got expected hal_status: ${data.hal_status}`);
      
      // Check hal_evaluations db
      const { data: halDb, error: halErr } = await db
        .from('hal_evaluations')
        .select('*')
        .eq('decision', data.hal_status)
        .order('ts', { ascending: false })
        .limit(1)
        .single();
        
      if (halErr || !halDb) {
        console.error(`TEST FAIL: hal_evaluations write missing for ${tc.name}. Err: ${halErr?.message}`);
        server.close();
        process.exit(1);
      }
      console.log(`  ✓ DB write verified. Cost recorded: ${halDb.cost_usd} USD`);
    } else {
      const data: any = await res.json();
      console.log(`  ✓ Got expected 451 Block. Reason: ${data.reason}, Class: ${data.veto_class}`);
    }
  }

  console.log('\nTEST PASS: anfis-with-hal logic verified');
  server.close();
}

main().catch(console.error);
