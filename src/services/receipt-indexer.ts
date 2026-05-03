import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs';
import path from 'path';

dotenv.config();

const ajv = new Ajv();
addFormats(ajv);

let receiptSchema: any;
try {
  const schemaPath = path.resolve(__dirname, '../../../../hyperdag-protocol/schemas/receipt.v1.json');
  receiptSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
} catch (e) {
  receiptSchema = { type: 'object' }; // Fallback
}
const validateSchema = ajv.compile(receiptSchema);

export async function startIndexer(config: {
  rpcUrl: string;
  contractAddress: string;
  fromBlock: number | 'latest';
  pollInterval: number;
}) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const supabaseUrl = process.env.SUPABASE_URL || 'http://localhost';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'key';
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Minimal ABI for the events we care about
  const abi = [
    "event ReceiptCommitted(bytes32 indexed receiptId)",
    "event ReceiptRevealed(bytes32 indexed receiptId, string receiptUri)",
    "event ReceiptInvalidated(bytes32 indexed receiptId)"
  ];
  
  const contract = new ethers.Contract(config.contractAddress, abi, provider);

  console.log(`[Indexer] Starting on ${config.contractAddress} from block ${config.fromBlock}...`);

  contract.on("ReceiptCommitted", async (receiptId, event) => {
    console.log(`[Indexer] ReceiptCommitted: ${receiptId}`);
    // Sync to DB
    await supabase.from('hyperdag_receipts').upsert({
      receipt_id: receiptId,
      status: 'committed',
      updated_at: new Date().toISOString()
    }, { onConflict: 'receipt_id' });
  });

  contract.on("ReceiptRevealed", async (receiptId, receiptUri, event) => {
    console.log(`[Indexer] ReceiptRevealed: ${receiptId} at ${receiptUri}`);
    
    // Fetch JSON from URI
    let receiptJson: any = null;
    try {
      if (receiptUri.startsWith('http')) {
        const response = await fetch(receiptUri);
        receiptJson = await response.json();
      } else {
        console.warn(`[Indexer] Unsupported protocol for URI: ${receiptUri}`);
        return;
      }
    } catch (e: any) {
      console.error(`[Indexer] Error fetching receipt JSON: ${e.message}`);
      return;
    }

    // Validate against schema
    if (!validateSchema(receiptJson)) {
      console.error(`[Indexer] Schema validation failed for ${receiptId}`);
      return;
    }

    // Upsert to hyperdag_receipts
    await supabase.from('hyperdag_receipts').upsert({
      receipt_id: receiptId,
      receipt_uri: receiptUri,
      status: 'revealed',
      payload: receiptJson,
      updated_at: new Date().toISOString()
    }, { onConflict: 'receipt_id' });

    // Check if Trinity validation is pending
    // We queue a task for the swarm
    const { data: existingTasks } = await supabase
      .from('trinity_tasks')
      .select('id')
      .eq('task_type', 'receipt_validation')
      .contains('metadata', { receiptId });

    if (!existingTasks || existingTasks.length === 0) {
      await supabase.from('trinity_tasks').insert({
        title: `Validate Receipt ${receiptId}`,
        description: `Trinity swarm needs to validate revealed receipt ${receiptId}`,
        task_type: 'receipt_validation',
        status: 'pending',
        priority: 90,
        assigned_to: null,
        metadata: {
          receiptId: receiptId,
          receiptUri: receiptUri
        }
      });
      console.log(`[Indexer] Enqueued Trinity task for receipt ${receiptId}`);
    }
  });

  contract.on("ReceiptInvalidated", async (receiptId, event) => {
    console.log(`[Indexer] ReceiptInvalidated: ${receiptId}`);
    await supabase.from('hyperdag_receipts').upsert({
      receipt_id: receiptId,
      status: 'invalidated',
      updated_at: new Date().toISOString()
    }, { onConflict: 'receipt_id' });
  });

  // Basic polling loop to check aggregation/BFT status
  setInterval(async () => {
    try {
      await checkBftAggregation(supabase);
    } catch (e: any) {
      console.error(`[Indexer] BFT check error: ${e.message}`);
    }
  }, config.pollInterval || 5000);
}

async function checkBftAggregation(supabase: any) {
  // Find receipts that are pending BFT resolution
  const { data: receipts } = await supabase
    .from('hyperdag_receipts')
    .select('receipt_id')
    .eq('status', 'revealed');

  if (!receipts) return;

  for (const r of receipts) {
    const { data: validators } = await supabase
      .from('trinity_receipt_validators')
      .select('verdict')
      .eq('receipt_id', r.receipt_id);

    if (!validators) continue;

    const decisive = validators.filter((v: any) => v.verdict !== 'indeterminate' && v.verdict !== 'pending');
    if (decisive.length >= 4) {
      const passCount = decisive.filter((v: any) => v.verdict === 'pass').length;
      const vetoCount = decisive.filter((v: any) => v.verdict === 'veto').length;
      const ratio = passCount / decisive.length;

      let finalVerdict = 'inconclusive';
      if (vetoCount >= 1) { // Ignoring Pythagorean Comma actual logic in indexer polling
        finalVerdict = 'veto';
      } else if (ratio >= 0.618) {
        finalVerdict = 'pass';
      }

      if (finalVerdict !== 'inconclusive') {
        // Mark receipt as validated
        await supabase.from('hyperdag_receipts').update({
          status: 'validated',
          updated_at: new Date().toISOString()
        }).eq('receipt_id', r.receipt_id);

        await supabase.from('trinity_receipt_bft_results').upsert({
          receipt_id: r.receipt_id,
          final_verdict: finalVerdict,
          pass_count: passCount,
          veto_count: vetoCount,
          indeterminate_count: validators.length - decisive.length,
          decisive_count: decisive.length,
          pass_ratio: ratio
        }, { onConflict: 'receipt_id' });

        console.log(`[Indexer] Receipt ${r.receipt_id} achieved BFT: ${finalVerdict}`);
      }
    }
  }
}
