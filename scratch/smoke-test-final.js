const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function smokeTest() {
  console.log('🧪 Starting E2E Smoke Test...');
  
  // 1. Pick a working agent (SOPHIA or one of the 30)
  // We know aa17d58e-8194-478b-9151-f6dc9fd8cdbe worked.
  const agent_id = 'aa17d58e-8194-478b-9151-f6dc9fd8cdbe';
  
  // 2. Insert a score event
  console.log('   Inserting score event...');
  const { data: event, error: evErr } = await supabase
    .from('repid_score_events')
    .insert({
      agent_id: agent_id,
      repid_before: 7400,
      repid_after: 7500,
      hallucination_caught: false,
      event_type: 'CHALLENGE_WIN',
      delta: 100
    })
    .select()
    .single();

  if (evErr) {
    console.error('Failed to insert event:', evErr);
    return;
  }

  console.log(`   Event created: ${event.id}`);

  // 3. Manually trigger the queue logic (since we aren't running the server)
  // We'll simulate what src/scoring/pipeline.ts does.
  const job_id = crypto.randomUUID();
  console.log(`   Simulating queue insertion (Job: ${job_id})...`);
  
  const { data: job, error: jobErr } = await supabase
    .from('repid_proof_queue')
    .insert({
      job_id: job_id,
      agent_id: agent_id,
      event_id: event.id,
      status: 'pending',
      zkp_service_url: 'https://zkp-postcard-production.up.railway.app'
    })
    .select()
    .single();

  if (jobErr) {
    console.error('Failed to insert job:', jobErr);
    return;
  }

  // 4. Call the ZKP service
  console.log('   Calling ZKP service...');
  const res = await fetch('https://zkp-postcard-production.up.railway.app/zkp/repid-proof', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agent_id,
      score: 7500,
      metadata: { job_id: job_id }
    })
  });

  if (!res.ok) {
    console.error(`   ❌ ZKP Service failed with ${res.status}`);
    return;
  }

  const proof = await res.json();
  console.log('   ✅ Proof received:', proof.commitment);

  // 5. Update DB
  console.log('   Updating DB status...');
  await supabase.from('repid_proof_queue').update({
    status: 'completed',
    proof_hash: proof.commitment,
    completed_at: new Date().toISOString()
  }).eq('id', job.id);

  console.log('🏁 Smoke test SUCCESS!');
}

smokeTest();
