import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pgQuery } from '../db/direct-pg';

const router = Router();

// POST /identity/claim
router.post('/claim', async (req: Request, res: Response) => {
  const { holder_did, handle_type, handle } = req.body ?? {};

  if (!holder_did || !handle_type || !handle) {
    return res.status(400).json({ error: 'holder_did, handle_type, and handle are required' });
  }

  try {
    // Hash the handle - never store raw
    const handleHash = crypto.createHash('sha256').update(String(handle).trim().toLowerCase()).digest('hex');

    // Idempotent UPSERT on handle_type and handle_hash
    const result = await pgQuery(
      `INSERT INTO identity_claims (holder_did, handle_type, handle_hash, status, updated_at)
       VALUES ($1, $2, $3, 'claimable', now())
       ON CONFLICT (handle_type, handle_hash) 
       DO UPDATE SET holder_did = EXCLUDED.holder_did, status = 'claimable', updated_at = now()
       RETURNING id, holder_did, handle_type, handle_hash, status, created_at, updated_at`,
      [holder_did, handle_type, handleHash]
    );

    const claim = result[0];

    return res.status(200).json({
      success: true,
      claim_id: claim.id,
      holder_did: claim.holder_did,
      handle_type: claim.handle_type,
      handle_hash: claim.handle_hash,
      status: claim.status,
      created_at: claim.created_at,
      updated_at: claim.updated_at
    });

  } catch (err: any) {
    console.error('Error claiming identity:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
