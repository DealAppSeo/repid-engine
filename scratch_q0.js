const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  console.log('--- Q0.1 ---');
  const ids = [
    '015a8fd7-3c45-48eb-90ea-51021c703efe',
    'df1738cb-6fd2-4d15-a4f4-260d35c581b4',
    '496a4ec7-1fb7-48db-a3ee-09e5720fe8cb'
  ];
  const q1 = await db.from('validation_queue')
    .select(`
      id, task_id, status, metadata,
      validator_agents, pcp_score, judge_verdict, judge_confidence,
      trinity_tasks!inner(status, claimed_by)
    `)
    .in('id', ids)
    .order('created_at');
  
  if (q1.error) console.error(q1.error);
  else {
    for (const row of q1.data) {
        console.log({
            vq_id: row.id,
            task_id: row.task_id,
            status: row.status,
            delta_applied: row.metadata?.hitl_delta_applied,
            resolution: row.metadata?.hitl_resolution,
            task_status: row.trinity_tasks?.status,
            claimed_by: row.trinity_tasks?.claimed_by,
            validator_agents: row.validator_agents,
        });
    }
  }

  for (const row of q1.data || []) {
      const { count: eventsCount } = await db.from('repid_score_events').select('*', { count: 'exact', head: true }).eq('metadata->>task_id', String(row.task_id));
      const { count: auditCount } = await db.from('hal_audit_chain').select('*', { count: 'exact', head: true }).eq('source_table', 'validation_queue').eq('source_id', String(row.id));
      console.log(`Counts for task ${row.task_id}: repid_events=${eventsCount}, audit_entries=${auditCount}`);
  }

  console.log('--- Q0.2 ---');
  console.log('p_source_table text, p_source_id text, p_event_payload jsonb, p_canonical_json_text text');
}

run().catch(console.error);
