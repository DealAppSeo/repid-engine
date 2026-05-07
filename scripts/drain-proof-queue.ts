import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ZKP_SERVICE_URL = process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app';

async function drain() {
  console.log('🚀 Starting ZK Proof Queue Drain...');
  
  while (true) {
    // 1. Fetch pending jobs
    const { data: jobs, error } = await supabase
      .from('repid_proof_queue')
      .select('id, job_id, agent_id, event_id, status')
      .eq('status', 'pending')
      .eq('zkp_service_url', ZKP_SERVICE_URL)
      .limit(100); 

    if (error) {
      console.error('Failed to fetch jobs:', error);
      break;
    }

    if (!jobs || jobs.length === 0) {
      console.log('✅ No more pending jobs found.');
      break;
    }

    console.log(`📦 Processing batch of ${jobs.length} jobs...`);

    for (const job of jobs) {
      try {
        // 2. Get the score from repid_score_events
        const { data: event, error: evErr } = await supabase
          .from('repid_score_events')
          .select('repid_after')
          .eq('id', job.event_id)
          .single();

        if (evErr || !event) {
          await supabase.from('repid_proof_queue').update({ status: 'failed', error_message: 'Score event not found' }).eq('id', job.id);
          continue;
        }

        const score = Math.round(event.repid_after);
        
        // 3. POST to ZKP service
        const res = await fetch(`${ZKP_SERVICE_URL}/zkp/repid-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agent_id: job.agent_id,
            score: score,
            metadata: { job_id: job.job_id }
          })
        });

        if (res.ok) {
          const proof = await res.json();
          await supabase.from('repid_proof_queue').update({ 
            status: 'completed',
            proof_hash: proof.commitment,
            completed_at: new Date().toISOString()
          }).eq('id', job.id);
        } else {
          const errText = await res.text();
          await supabase.from('repid_proof_queue').update({ 
            status: 'failed', 
            error_message: `HTTP ${res.status}: ${errText}` 
          }).eq('id', job.id);
        }

      } catch (err: any) {
        await supabase.from('repid_proof_queue').update({ 
          status: 'failed', 
          error_message: err.message 
        }).eq('id', job.id);
      }
    }
    console.log(`✅ Batch complete.`);
  }

  console.log('\n🏁 Drain complete.');
}

drain();
