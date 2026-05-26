import { Router, Request, Response } from 'express';
import { db } from '../db';
import crypto from 'crypto';

const router = Router();

// Helper to get agent private key from env
export function getAgentPrivateKey(agentName: string): string {
  // Map "trinity-mel" to "MEL", "trinity-sophia" to "SOPHIA", etc.
  const cleanName = agentName.replace('trinity-', '').toUpperCase().trim();
  const envKey = `${cleanName}_PRIVATE_KEY`;
  const pk = process.env[envKey] || process.env.TRUSTRAILS_HMAC_SECRET || 'trinity-default-sbt-secret';
  return pk;
}

router.post('/respond', async (req: Request, res: Response) => {
  const { queue_id, verifier_agent_id, verifier_response_id, verdict, signature } = req.body ?? {};

  if (!queue_id || !verifier_agent_id || !verifier_response_id || !verdict || !signature) {
    return res.status(400).json({
      error: 'queue_id, verifier_agent_id, verifier_response_id, verdict, signature are required',
    });
  }

  if (!['verified', 'disputed', 'timeout'].includes(verdict)) {
    return res.status(400).json({ error: 'invalid verdict value' });
  }

  try {
    // 1. Fetch queue entry
    const { data: queueEntry, error: queueErr } = await db
      .from('peer_verification_queue')
      .select('*')
      .eq('id', queue_id)
      .single();

    if (queueErr || !queueEntry) {
      return res.status(404).json({ error: 'Queue entry not found' });
    }

    if (queueEntry.verification_status !== 'pending' && queueEntry.verification_status !== 'in_review') {
      return res.status(400).json({ error: 'Queue entry is already processed' });
    }

    // 2. Resolve verifier agent UUID and name
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name')
      .or(`id.eq.${/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(verifier_agent_id) ? verifier_agent_id : '00000000-0000-0000-0000-000000000000'},agent_name.eq.${verifier_agent_id}`)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ error: `Verifier agent ${verifier_agent_id} not found` });
    }

    const verifierName = agent.agent_name;
    const verifierUuid = agent.id;

    // Prevent original claimant from verifying
    if (verifierUuid === queueEntry.source_agent_id) {
      return res.status(400).json({ error: 'Self-verification is not permitted' });
    }

    // 3. Verify HMAC signature using agent-specific private key
    const secretKey = getAgentPrivateKey(verifierName);
    const dataToSign = `${queue_id}:${verifier_response_id}:${verdict}`;
    const expectedSignature = crypto.createHmac('sha256', secretKey).update(dataToSign).digest('hex');

    let isValid = false;
    try {
      isValid = crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      );
    } catch {
      isValid = (signature === expectedSignature);
    }

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid verifier signature' });
    }

    // 4. Update queue row
    const { error: updateErr } = await db
      .from('peer_verification_queue')
      .update({
        verification_status: verdict,
        verifier_agent_id: verifierUuid,
        verifier_response_id: verifier_response_id,
        verifier_signature: signature,
        completed_at: new Date().toISOString(),
      })
      .eq('id', queue_id);

    if (updateErr) {
      return res.status(500).json({ error: `Failed to update queue: ${updateErr.message}` });
    }

    // 5. Complete matching task in trinity_tasks (if dispatched)
    const { data: tasks } = await db
      .from('trinity_tasks')
      .select('id, metadata')
      .eq('assigned_to', verifierName)
      .in('status', ['pending', 'todo', 'in_progress']);

    const matchingTask = tasks?.find(
      (t) => (t.metadata as any)?.peer_verification_queue_id?.toString() === queue_id.toString()
    );

    if (matchingTask) {
      await db
        .from('trinity_tasks')
        .update({
          status: 'completed',
          result: `Peer verification completed with verdict: ${verdict}`,
          completed_at: new Date().toISOString(),
        })
        .eq('id', matchingTask.id);
    }

    return res.json({
      success: true,
      queue_id,
      verdict,
      agreement_score: verdict === 'verified' ? 1.0 : 0.0,
      completed_at: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
