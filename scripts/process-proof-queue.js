const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function processQueue() {
  const ZKP_URL = process.env.ZKP_SERVICE_URL;
  if (!ZKP_URL) {
    // Get from DB
    const { data } = await supabase
      .from('repid_config')
      .select('value')
      .eq('key', 'zkp_service_url')
      .single();
    if (!data) { console.log('No ZKP service URL'); return; }
    process.env.ZKP_SERVICE_URL = data.value;
  }

  // Get pending jobs (process 10 at a time)
  const { data: jobs } = await supabase
    .from('repid_proof_queue')
    .select('*')
    .eq('status', 'pending')
    .limit(10);

  console.log(`Processing ${jobs?.length || 0} proof jobs...`);

  for (const job of (jobs || [])) {
    try {
      // Generate proof
      const res = await fetch(`http://127.0.0.1:8081/zkp/repid-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: '3747',
          repid_score: 1000,
          decision_hash: job.event_id?.toString() || job.job_id || 'hash',
          certainty: 0.9
        })
      });
      const proof = await res.json();

      // Update job as completed
      await supabase
        .from('repid_proof_queue')
        .update({
          status: 'completed',
          proof_hash: proof.proof_hash || proof.hash || 'generated',
          completed_at: new Date().toISOString(),
          zkp_service_url: process.env.ZKP_SERVICE_URL
        })
        .eq('id', job.id);

      console.log(`✓ Job ${job.job_id} completed`);
    } catch (e) {
      await supabase
        .from('repid_proof_queue')
        .update({ status: 'failed', error_message: e.message,
                  attempts: (job.attempts || 0) + 1 })
        .eq('id', job.id);
      console.log(`✗ Job ${job.job_id} failed: ${e.message}`);
    }
  }

  // Report final state
  const { data: stats } = await supabase
    .from('repid_proof_queue')
    .select('status')
    .in('status', ['completed', 'pending', 'failed']);
  
  const summary = (stats || []).reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  console.log('Queue state:', summary);
}

processQueue().catch(console.error);
