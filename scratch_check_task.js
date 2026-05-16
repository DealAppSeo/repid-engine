const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  const vqId = '763b104c-d61e-4842-8246-ef8131212fc7'; // From backend log
  const taskId = 200523; // From backend log

  const [vqResult, ttResult, repidResult, auditResult] = await Promise.all([
    db.from('validation_queue').select('*').eq('id', vqId).single(),
    db.from('trinity_tasks').select('status').eq('id', taskId).single(),
    db.from('repid_score_events').select('id', { count: 'exact', head: true }).filter('metadata->>task_id', 'eq', taskId.toString()),
    db.from('hal_audit_chain').select('id', { count: 'exact', head: true }).eq('source_table', 'validation_queue').eq('source_id', vqId),
  ]);
  
  console.log('VQ Status:', vqResult.data?.status);
  console.log('ProcessedAt:', vqResult.data?.processed_at);
  console.log('Delta applied:', vqResult.data?.metadata?.hitl_delta_applied);
  console.log('Fully finalized:', vqResult.data?.metadata?.hitl_finalized);
  console.log('Task Status:', ttResult.data?.status);
  console.log('RepID events:', repidResult.count);
  console.log('Audit events:', auditResult.count);
}
check();
