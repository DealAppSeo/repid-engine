import express from 'express';
import bodyParser from 'body-parser';
import inboundRouter from '../src/routes/x402-inbound';
import { x402Facilitator } from '../src/services/x402-facilitator';
import { db } from '../src/db';
import { Wallet } from 'ethers';

const app = express();
app.use(bodyParser.json());
app.use('/x402', inboundRouter);

async function main() {
  console.log('--- Phase 1: ANFIS x402 Dry Run ---');

  // Mock Facilitator to avoid chain interactions
  x402Facilitator.verifyPayment = async () => ({ valid: true, payer: '0xmockpayer' });
  x402Facilitator.settlePayment = async () => ({ txHash: '0xmock_settlement_tx_hash' });

  // Mock DB for agent lookup and feedback loop write
  let insertCalledWith: any = null;
  const mockDbInsert = async (payload: any) => {
    insertCalledWith = payload;
    return { error: null };
  };

  const originalFrom = db.from;
  (db as any).from = (table: string) => {
    if (table === 'repid_agents') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: '32e0e809-c1c4-4405-913f-135c8a2d6626',
                agent_name: 'trinity-shofet',
                erc8004_address: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d',
                current_repid: 2510,
                tier: 'spokesperson'
              },
              error: null
            })
          })
        })
      } as any;
    }
    if (table === 'repid_events') {
      return { insert: mockDbInsert } as any;
    }
    return originalFrom.bind(db)(table);
  };

  const server = app.listen(3005, async () => {
    console.log('Test server running on port 3005');
    
    const targetUrl = 'http://localhost:3005/x402/32e0e809-c1c4-4405-913f-135c8a2d6626/anfis-classify';
    
    console.log('\n1. Sending initial request (expecting 402)...');
    const res1 = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'Help me write code' })
    });
    
    if (res1.status !== 402) {
      console.error(`Expected 402, got ${res1.status}`);
      server.close();
      return;
    }
    
    const data1 = await res1.json();
    console.log('402 Response accepts:', data1.accepts);

    console.log('\n2. Constructing mock payment payload...');
    const paymentPayload = 'mock_payment_payload_b64';
    console.log('Constructed Payload:', paymentPayload);

    console.log('\n3. Sending second request with X-PAYMENT header...');
    const res2 = await fetch(targetUrl, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-PAYMENT': paymentPayload
      },
      body: JSON.stringify({ payload: 'Help me write code' })
    });

    if (res2.status !== 200) {
      console.error(`Expected 200, got ${res2.status}`, await res2.text());
      server.close();
      return;
    }

    const data2 = await res2.json();
    console.log('Classification Response:', data2);
    
    console.log('\n4. Verifying DB effects (repid_events write)...');
    if (insertCalledWith) {
      console.log('Success: repid_events mock insert was called with:', JSON.stringify(insertCalledWith, null, 2));
    } else {
      console.error('Failure: repid_events mock insert was NOT called.');
    }

    console.log('\nPhase 1 Dry-Run Complete.');
    server.close();
  });
}

main().catch(console.error);
