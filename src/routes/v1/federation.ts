/**
 * Federated developer-node onboarding — V2 SUBSTRATE (stubbed-but-functional).
 *
 * Lets a self-hosted developer node register, heartbeat, and (once opted-in + verified)
 * submit federated-learning events. This is node-facing: access is gated by node_id +
 * challenge_nonce / federation opt-in state, NOT by an SBT or REPID_API_KEY. Mounted in the
 * public-ish section of src/index.ts (before authMiddleware).
 *
 * STUBBED-FUNCTIONAL: every endpoint validates input and writes to the developer_nodes /
 * federation_events tables (migration 20260526120000 — NOT applied; orchestrator applies).
 * There is NO live federation yet — the reachability "challenge" is a locally-generated nonce
 * the node must later echo back; no outbound calls are made. No federated learning runs here.
 *
 * Depends on tables: developer_nodes, federation_events.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../../db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const LICENSE_TIERS = ['free_federated', 'licensed_silo'] as const;

export interface FederationRegisterBody {
  owner_email?: unknown;
  node_url?: unknown;
  license_tier?: unknown;
  federated_optin?: unknown;
}

/**
 * Pure validation for POST /register (unit-testable, no IO).
 * Returns the cleaned fields or an error message.
 */
export function validateFederationRegister(
  body: FederationRegisterBody,
):
  | { ok: true; owner_email: string; node_url: string; license_tier: 'free_federated' | 'licensed_silo'; federated_optin: boolean }
  | { ok: false; error: string } {
  const owner_email = typeof body.owner_email === 'string' ? body.owner_email.trim().toLowerCase() : '';
  const node_url = typeof body.node_url === 'string' ? body.node_url.trim() : '';
  const license_tier_raw =
    typeof body.license_tier === 'string' && body.license_tier.trim() ? body.license_tier.trim() : 'free_federated';
  const federated_optin = body.federated_optin === true || body.federated_optin === 'true';

  if (!owner_email || !EMAIL_RE.test(owner_email)) return { ok: false, error: 'valid owner_email required' };
  if (owner_email.length > 254) return { ok: false, error: 'owner_email too long' };
  if (!node_url || !URL_RE.test(node_url)) return { ok: false, error: 'valid node_url required (http/https)' };
  if (node_url.length > 2048) return { ok: false, error: 'node_url too long' };
  if (!(LICENSE_TIERS as readonly string[]).includes(license_tier_raw)) {
    return { ok: false, error: "license_tier must be 'free_federated' or 'licensed_silo'" };
  }

  return {
    ok: true,
    owner_email,
    node_url,
    license_tier: license_tier_raw as 'free_federated' | 'licensed_silo',
    federated_optin,
  };
}

const router = Router();

/**
 * POST /register — onboard a developer node.
 * Body: { owner_email, node_url, license_tier?, federated_optin? }
 * Inserts a developer_nodes row (status='pending') with a freshly-generated challenge_nonce
 * the node must echo back (placeholder reachability challenge — no outbound call here).
 * Returns the node id + challenge_nonce.
 */
router.post('/register', async (req: Request, res: Response) => {
  const v = validateFederationRegister(req.body ?? {});
  if (!v.ok) return res.status(400).json({ error: v.error });

  const challenge_nonce = crypto.randomBytes(24).toString('hex');

  const { data, error } = await db
    .from('developer_nodes')
    .insert({
      owner_email: v.owner_email,
      node_url: v.node_url,
      license_tier: v.license_tier,
      federated_optin: v.federated_optin,
      status: 'pending',
      challenge_nonce,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[federation] register insert failed:', error?.message);
    return res.status(500).json({ error: 'register_failed' });
  }

  return res.status(201).json({
    node_id: data.id,
    status: 'pending',
    challenge_nonce,
    message: 'Node registered. Echo back challenge_nonce to complete reachability verification (V2 substrate — verification stubbed).',
  });
});

/**
 * POST /heartbeat — node liveness ping.
 * Body: { node_id, sbt_id? }
 * Updates last_heartbeat_at (and sbt_id if provided). Returns ok + current status.
 */
router.post('/heartbeat', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { node_id?: unknown; sbt_id?: unknown };
  const nodeId = Number(body.node_id);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    return res.status(400).json({ error: 'valid node_id required' });
  }
  const sbt_id = typeof body.sbt_id === 'string' && body.sbt_id.trim() ? body.sbt_id.trim() : undefined;

  const update: Record<string, unknown> = { last_heartbeat_at: new Date().toISOString() };
  if (sbt_id) update.sbt_id = sbt_id;

  const { data, error } = await db
    .from('developer_nodes')
    .update(update)
    .eq('id', nodeId)
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('[federation] heartbeat update failed:', error.message);
    return res.status(500).json({ error: 'heartbeat_failed' });
  }
  if (!data) return res.status(404).json({ error: 'node not found' });

  return res.status(200).json({ ok: true, node_id: data.id, status: data.status });
});

/**
 * POST /event-stream — federated-learning event submission (stub).
 * Body: { node_id, event_type, payload }
 * ONLY accepts when the node has federated_optin=true AND status='verified'; otherwise 403.
 * Inserts a federation_events row. No federated learning runs here (V2 substrate).
 */
router.post('/event-stream', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { node_id?: unknown; event_type?: unknown; payload?: unknown };
  const nodeId = Number(body.node_id);
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    return res.status(400).json({ error: 'valid node_id required' });
  }
  const event_type = typeof body.event_type === 'string' ? body.event_type.trim() : '';
  if (!event_type) return res.status(400).json({ error: 'event_type required' });
  const payload = body.payload ?? null;

  const { data: node, error: nodeErr } = await db
    .from('developer_nodes')
    .select('id, federated_optin, status')
    .eq('id', nodeId)
    .maybeSingle();

  if (nodeErr) {
    console.error('[federation] event-stream node lookup failed:', nodeErr.message);
    return res.status(500).json({ error: 'event_stream_failed' });
  }
  if (!node) return res.status(404).json({ error: 'node not found' });

  if (!(node as any).federated_optin || (node as any).status !== 'verified') {
    return res.status(403).json({ error: 'federation opt-in + verification required' });
  }

  const { data, error } = await db
    .from('federation_events')
    .insert({ node_id: nodeId, event_type, payload })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[federation] event insert failed:', error?.message);
    return res.status(500).json({ error: 'event_stream_failed' });
  }

  return res.status(201).json({
    ok: true,
    event_id: data.id,
    message: 'Federated event recorded (V2 substrate — no live federated learning yet).',
  });
});

export default router;
