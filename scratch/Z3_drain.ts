import { db } from '../src/db';
import fetch from 'node-fetch';

const ZKP_SERVICE_URL = process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app';

async function drain() {
  console.log(`Starting Z3 Drain against ${ZKP_SERVICE_URL}`);

  const { data: pending, error } = await db
    .from('repid_proof_queue')
    .select('id, job_id, agent_id, status')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Failed to fetch pending jobs:', error);
    process.exit(1);
  }

  console.log(`Found ${pending?.length || 0} pending jobs.`);
  if (!pending || pending.length === 0) process.exit(0);

  let successCount = 0;
  let failCount = 0;

  for (const job of pending) {
    try {
      // 1. Get current agent score
      const { data: agent } = await db
        .from('repid_agents')
        .select('current_repid, tier')
        .eq('id', job.agent_id)
        .single();

      if (!agent) {
        console.warn(`Agent ${job.agent_id} not found for job ${job.id}. Skipping.`);
        continue;
      }

      // 2. Call ZKP service
      console.log(`[${job.id}] Proving agent ${job.agent_id} (score=${agent.current_repid})...`);
      const res = await fetch(`${ZKP_SERVICE_URL}/zkp/repid-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: job.agent_id,
          repid_score: agent.current_repid,
          threshold: 5000,
          tier: agent.tier
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`ZKP service returned ${res.status}: ${text}`);
      }

      const proof = await res.json() as any;

      // 3. Update queue row
      const { error: updateErr } = await db
        .from('repid_proof_queue')
        .update({
          status: 'completed',
          proof_hash: proof.commitment,
          proof_size_bytes: proof.proof_size_bytes,
          completed_at: new Date().toISOString(),
          attempts: 1
        })
        .eq('id', job.id);

      if (updateErr) {
        throw new Error(`DB update failed: ${updateErr.message}`);
      }

      successCount++;
      console.log(`[${job.id}] SUCCESS: ${proof.commitment.substring(0, 10)}...`);

      // Rate limiting: batch of 50 with 30s gap would be slow for 2641.
      // I'll do 1s gap between each for now to see it move.
      await new Promise(r => setTimeout(r, 100));

    } catch (err: any) {
      failCount++;
      console.error(`[${job.id}] FAILED: ${err.message}`);
      await db.from('repid_proof_queue').update({
        attempts: 1,
        error_message: err.message
      }).eq('id', job.id);
    }

    if (successCount >= 5 && successCount % 50 === 0) {
        console.log(`--- Progress: ${successCount} success, ${failCount} fail. Pausing 5s... ---`);
        await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log(`Drain complete. Success: ${successCount}, Fail: ${failCount}`);
  process.exit(0);
}

drain();
