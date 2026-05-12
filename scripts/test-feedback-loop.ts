import { db } from '../src/db';
import { feedbackLoopWorker } from '../src/workers/feedback-loop-worker';

async function test() {
  console.log('--- Phase 4: Feedback Loop Worker Test ---');

  const mockWriter = {
    chainId: 84532,
    getContractAddress: () => '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    writeRepIDFeedback: async (args: any) => {
      console.log('[MOCK] writeRepIDFeedback called with:', args);
      return {
        txHash: '0xmock_reputation_tx_' + Date.now(),
        blockNumber: 123456,
        gasUsed: '50000'
      };
    }
  };

  console.log('--- Phase 4: Feedback Loop Worker Test ---');


  const SOPHIA_ID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

  try {
    // 1. Insert mock event
    console.log('Inserting mock x402_inbound_settled event...');
    const { data: event, error } = await db.from('repid_events').insert({
      subject_id: SOPHIA_ID,
      subject_type: 'agent',
      event_type: 'x402_inbound_settled',
      reputation_delta: 5,
      event_data: { tx_hash: '0xmock_payment_tx' }
    }).select().single();


    if (error) throw error;
    console.log(`Event inserted with ID: ${event.id}`);

    // 2. Run worker
    console.log('\nRunning FeedbackLoopWorker cycle with mock writer...');
    await feedbackLoopWorker.runOnce(mockWriter);


    // 3. Verify event is processed
    const { data: processedEvent } = await db.from('repid_events').select('*').eq('id', event.id).single();
    if (processedEvent?.processed_at) {
      console.log('PASS: Event was processed at', processedEvent.processed_at);
      console.log('Reputation Tx Hash:', (processedEvent.event_data as any).reputation_tx_hash);
    } else {
      console.error('FAIL: Event was not processed.');
    }


  } catch (e: any) {
    console.error('ERROR during test:', e.message);
  }
}

test();
