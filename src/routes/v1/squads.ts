import { Router, Request, Response } from 'express';
import { db } from '../../db';

const router = Router();

// Helper to check squad ownership
async function verifySquadOwner(squadId: string, ownerHumanSbtId: string): Promise<boolean> {
  const { data: squad, error } = await db
    .from('squad')
    .select('owner_human_sbt_id')
    .eq('id', squadId)
    .maybeSingle();

  if (error || !squad) return false;
  return squad.owner_human_sbt_id === ownerHumanSbtId;
}

// 1. POST /api/v1/squads - Create squad
router.post('/', async (req: Request, res: Response) => {
  const { name, owner_human_sbt_id, license_tier } = req.body ?? {};

  if (!name || !owner_human_sbt_id) {
    return res.status(400).json({ error: 'name and owner_human_sbt_id are required' });
  }

  try {
    // Validate human SBT exists
    const { data: sbt, error: sbtErr } = await db
      .from('human_sbt_registry')
      .select('token_id')
      .eq('token_id', owner_human_sbt_id)
      .maybeSingle();

    if (sbtErr || !sbt) {
      return res.status(400).json({ error: `Human SBT token_id '${owner_human_sbt_id}' not found in registry` });
    }

    // Insert squad
    const { data: squad, error: insertErr } = await db
      .from('squad')
      .insert({
        name,
        owner_human_sbt_id,
        license_tier: license_tier || 'free_federated'
      })
      .select('*')
      .single();

    if (insertErr) {
      return res.status(500).json({ error: `Failed to create squad: ${insertErr.message}` });
    }

    return res.status(201).json(squad);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/v1/squads/:id - Squad details + active members
router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const { data: squad, error: squadErr } = await db
      .from('squad')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (squadErr || !squad) {
      return res.status(404).json({ error: 'Squad not found' });
    }

    // Fetch active members
    const { data: members, error: membersErr } = await db
      .from('squad_membership')
      .select('agent_id, role, joined_at, is_delegate')
      .eq('squad_id', id)
      .is('left_at', null);

    if (membersErr) {
      return res.status(500).json({ error: `Failed to fetch members: ${membersErr.message}` });
    }

    return res.json({
      ...squad,
      members: members || []
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/v1/squads/:id/members - Add agent to squad
router.post('/:id/members', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { agent_id, role, is_delegate, owner_human_sbt_id } = req.body ?? {};

  if (!agent_id || !owner_human_sbt_id) {
    return res.status(400).json({ error: 'agent_id and owner_human_sbt_id are required' });
  }

  try {
    // Verify ownership
    const isOwner = await verifySquadOwner(String(id), String(owner_human_sbt_id || ''));
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the squad owner can modify squad composition' });
    }

    // Verify agent exists
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name')
      .eq('id', agent_id)
      .maybeSingle();

    if (agentErr || !agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Check if agent is already in an active squad
    const { data: activeMembership } = await db
      .from('squad_membership')
      .select('squad_id')
      .eq('agent_id', agent_id)
      .is('left_at', null)
      .maybeSingle();

    if (activeMembership) {
      return res.status(400).json({ error: 'Agent is already an active member of another squad' });
    }

    // Insert membership
    const { data: membership, error: insertErr } = await db
      .from('squad_membership')
      .insert({
        squad_id: id,
        agent_id,
        role: role || 'member',
        is_delegate: !!is_delegate
      })
      .select('*')
      .single();

    if (insertErr) {
      return res.status(500).json({ error: `Failed to add member: ${insertErr.message}` });
    }

    // Update repid_agents mapping for backwards compatibility
    await db
      .from('repid_agents')
      .update({
        squad_id: id,
        squad_role: role || 'member',
        joined_squad_at: new Date().toISOString()
      })
      .eq('id', agent_id);

    return res.status(201).json(membership);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. DELETE /api/v1/squads/:id/members/:agent_id - Remove agent
router.delete('/:id/members/:agent_id', async (req: Request, res: Response) => {
  const { id, agent_id } = req.params;
  const { owner_human_sbt_id, agent_voluntary } = req.body ?? {};

  try {
    let allowed = false;

    if (agent_voluntary === true) {
      allowed = true; // Agents can voluntarily leave squad
    } else if (owner_human_sbt_id) {
      // Squad owner can modify squad composition
      allowed = await verifySquadOwner(String(id), String(owner_human_sbt_id || ''));
    }

    if (!allowed) {
      return res.status(403).json({ error: 'Not authorized to remove agent. Requires owner human SBT or voluntary agent trigger.' });
    }

    const now = new Date().toISOString();

    // Mark left_at in membership
    const { data: updatedMembership, error: updateErr } = await db
      .from('squad_membership')
      .update({ left_at: now })
      .eq('squad_id', id)
      .eq('agent_id', agent_id)
      .is('left_at', null)
      .select('*');

    if (updateErr) {
      return res.status(500).json({ error: `Failed to remove member from squad_membership: ${updateErr.message}` });
    }

    if (!updatedMembership || updatedMembership.length === 0) {
      return res.status(404).json({ error: 'No active membership found for this agent in this squad' });
    }

    // Clear squad in repid_agents mapping
    await db
      .from('repid_agents')
      .update({
        squad_id: null,
        squad_role: null,
        joined_squad_at: null
      })
      .eq('id', agent_id);

    return res.json({ success: true, removed_at: now });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. POST /api/v1/squads/:id/delegate - Set delegate
router.post('/:id/delegate', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { agent_id, owner_human_sbt_id } = req.body ?? {};

  if (!agent_id || !owner_human_sbt_id) {
    return res.status(400).json({ error: 'agent_id and owner_human_sbt_id are required' });
  }

  try {
    // Verify ownership
    const isOwner = await verifySquadOwner(String(id), String(owner_human_sbt_id || ''));
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the squad owner can set delegates' });
    }

    // Verify agent is an active member
    const { data: membership, error: memErr } = await db
      .from('squad_membership')
      .select('id')
      .eq('squad_id', id)
      .eq('agent_id', agent_id)
      .is('left_at', null)
      .maybeSingle();

    if (memErr || !membership) {
      return res.status(400).json({ error: 'Agent is not an active member of this squad' });
    }

    // Clear existing delegates in this squad
    await db
      .from('squad_membership')
      .update({ is_delegate: false })
      .eq('squad_id', id)
      .is('left_at', null);

    // Set new delegate
    const { data: updated, error: updateErr } = await db
      .from('squad_membership')
      .update({ is_delegate: true })
      .eq('squad_id', id)
      .eq('agent_id', agent_id)
      .is('left_at', null)
      .select('*')
      .single();

    if (updateErr) {
      return res.status(500).json({ error: `Failed to set delegate: ${updateErr.message}` });
    }

    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
