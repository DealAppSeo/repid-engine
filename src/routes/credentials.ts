import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pgQuery } from '../db/direct-pg';

const router = Router();

// POST /credentials/issue
router.post('/issue', async (req: Request, res: Response) => {
  const { agent_id, conservator_address } = req.body ?? {};

  if (!agent_id || !conservator_address) {
    return res.status(400).json({ error: 'agent_id and conservator_address are required' });
  }

  try {
    // 1. Look up agent in DB
    const agentRes = await pgQuery(
      `SELECT id, agent_name, current_repid, domain_accuracy, canonical_agent_id FROM repid_agents WHERE id = $1 LIMIT 1`,
      [agent_id]
    );
    if (!agentRes || agentRes.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const agent = agentRes[0];

    // 2. Derive holder_did
    const holderDid = `did:ethr:${conservator_address.toLowerCase()}`;

    // 3. Look up ZKP proof in repid_zkp_proofs to reuse
    const proofRes = await pgQuery(
      `SELECT id, zk_commitment, proof_bytes FROM repid_zkp_proofs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agent_id]
    );
    const latestProof = proofRes && proofRes.length > 0 ? proofRes[0] : null;
    const zkCommitment = latestProof?.zk_commitment || `0xcommitment${crypto.randomBytes(20).toString('hex')}`;

    // 4. Compute privacy nullifier and binding hash
    const nullifier = crypto.createHash('sha256').update(`nullifier::${holderDid}::${agent_id}`).digest('hex');
    const bindingHash = crypto.createHash('sha256').update(`binding::${holderDid}::${agent_id}`).digest('hex');

    // 5. Check idempotency on binding
    const existingBinding = await pgQuery(
      `SELECT id, data_ref FROM identity_binding_ledger WHERE nullifier = $1 LIMIT 1`,
      [nullifier]
    );

    let credentialId: string;
    if (existingBinding && existingBinding.length > 0) {
      credentialId = existingBinding[0].data_ref;
      console.log(`[credentials] Binding already exists for nullifier: ${nullifier}, returning existing credential: ${credentialId}`);
    } else {
      credentialId = crypto.randomUUID();

      // 6. Insert into sandbox_repid_credentials
      const zkpProofPayload = JSON.stringify({
        repid_score: agent.current_repid,
        domain_accuracy: agent.domain_accuracy || {},
        zk_commitment: zkCommitment,
        proof_bytes: latestProof?.proof_bytes || null,
        proof_id: latestProof?.id || null
      });

      await pgQuery(
        `INSERT INTO sandbox_repid_credentials (id, holder_did, credential_type, zkp_proof, verified, issued_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [credentialId, holderDid, 'self_sovereign_repid', zkpProofPayload, false]
      );

      // 7. Bind human conservator and agent via agent_custodianship_links
      const linkId = crypto.randomUUID();
      const agentDbtId = agent.canonical_agent_id ? parseInt(agent.canonical_agent_id, 10) : 624; // fallback to 624 Mel if not parseable

      await pgQuery(
        `INSERT INTO agent_custodianship_links (id, human_address, agent_dbt_id, capabilities_hash, capabilities, expires_at, nonce, signature, status, linked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [
          linkId,
          conservator_address,
          agentDbtId,
          crypto.createHash('sha256').update(`capabilities::${agent_id}`).digest('hex'),
          JSON.stringify({}),
          2000000000n, // unix timestamp far in future
          1n,
          '0x_sandbox_stub_sig',
          'active'
        ]
      );

      // 8. Write entry to identity_binding_ledger
      const bindingId = crypto.randomUUID();
      await pgQuery(
        `INSERT INTO identity_binding_ledger (id, agent_id, nullifier, binding_hash, data_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [bindingId, agent_id, nullifier, bindingHash, credentialId]
      );
    }

    // 9. Retrieve created/existing credential
    const credRes = await pgQuery(
      `SELECT * FROM sandbox_repid_credentials WHERE id = $1 LIMIT 1`,
      [credentialId]
    );

    return res.status(201).json({
      success: true,
      credential_id: credentialId,
      holder_did: holderDid,
      nullifier: nullifier,
      binding_hash: bindingHash,
      credential: credRes[0]
    });

  } catch (err: any) {
    console.error('Error issuing credential:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /credentials/verify
router.post('/verify', async (req: Request, res: Response) => {
  const { credential_id } = req.body ?? {};

  if (!credential_id) {
    return res.status(400).json({ error: 'credential_id is required' });
  }

  try {
    // 1. Look up in sandbox_repid_credentials
    const credRes = await pgQuery(
      `SELECT * FROM sandbox_repid_credentials WHERE id = $1 LIMIT 1`,
      [credential_id]
    );

    if (!credRes || credRes.length === 0) {
      return res.status(404).json({ error: 'Credential not found' });
    }

    // 2. Flip verified to true
    await pgQuery(
      `UPDATE sandbox_repid_credentials SET verified = true WHERE id = $1`,
      [credential_id]
    );

    // 3. Get binding details to report nullifier
    const bindingRes = await pgQuery(
      `SELECT nullifier FROM identity_binding_ledger WHERE data_ref = $1 LIMIT 1`,
      [credential_id]
    );

    const cred = credRes[0];
    cred.verified = true;

    return res.json({
      verified: true,
      holder_did: cred.holder_did,
      nullifier: bindingRes && bindingRes.length > 0 ? bindingRes[0].nullifier : null,
      zkp_payload: JSON.parse(cred.zkp_proof || '{}')
    });

  } catch (err: any) {
    console.error('Error verifying credential:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
