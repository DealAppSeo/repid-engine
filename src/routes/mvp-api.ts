/**
 * S-WIRE-MVP — read/decision API over the eight new ecosystem tables, wiring them to the running
 * engine. Mounted AFTER authMiddleware (agent-facing; agents hold API keys). The frontend public
 * surface continues to use /leaderboard.
 *
 * Phases covered here:
 *  2  provider-trust   (GET list/:name, POST /refresh → aggregate trustchat_sessions)
 *  3  capabilities     (GET leaderboard, GET /:agent)              — assessment RUNNER deferred
 *  4  dna              (GET /graph, GET /:agent)                   — DNA writer/cron deferred
 *  5  x402-gate        (POST /authorize, GET /limits/:agent, GET /history/:agent)
 *  6  disputes         (GET list, GET /:id)                        — file/vote/appeal deferred*
 *  7  staking          (GET /:agent)                               — deposit/withdraw (on-chain) deferred
 *  8  zkp              (GET /config, POST /route)
 *
 * Deferred-with-reason (see sprint report): capability assessment runner (LLM-driven, costly);
 * collaboration-DNA writer (peer_verify/mentorship cron); dispute file/vote (BFT panel selection +
 * the global SQL-keyword body sanitizer rejects prose evidence containing ';' '--' etc.); staking
 * deposit/withdraw (real custody / on-chain); sponsorship endpoints (table does not exist).
 *
 * Route registration order matters: literal paths (/dna/graph) are declared before param paths
 * (/dna/:agent) so Express does not capture the literal as a param.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { updateProviderTrustScores, getProviderTrust } from '../services/provider-trust';
import { checkTransactionAuthority, loadAuthorityContext, limitForTier } from '../services/x402-gate';

const router = Router();
const fail = (res: Response, code: number, error: string, detail?: string) =>
  res.status(code).json({ error, detail });

// ---------------------------------------------------------------- Phase 2: provider trust
router.get('/provider-trust', async (_req: Request, res: Response) => {
  try { return res.json({ providers: await getProviderTrust() }); }
  catch (e: any) { return fail(res, 500, 'provider_trust_failed', e?.message); }
});

router.post('/provider-trust/refresh', async (_req: Request, res: Response) => {
  try { return res.json({ ok: true, ...(await updateProviderTrustScores()) }); }
  catch (e: any) { return fail(res, 500, 'provider_trust_refresh_failed', e?.message); }
});

router.get('/provider-trust/:name', async (req: Request, res: Response) => {
  const name = String(req.params.name).toLowerCase();
  try {
    const { data, error } = await db.from('provider_trust_scores').select('*').eq('provider_name', name);
    if (error) return fail(res, 500, 'provider_trust_failed', error.message);
    if (!data || data.length === 0) return fail(res, 404, 'provider_not_found', name);
    return res.json({ provider_name: name, models: data });
  } catch (e: any) { return fail(res, 500, 'provider_trust_failed', e?.message); }
});

// ---------------------------------------------------------------- Phase 3: agent capabilities (read)
router.get('/capabilities', async (req: Request, res: Response) => {
  const domain = req.query.domain ? String(req.query.domain) : null;
  try {
    let q = db.from('agent_capabilities').select('*').order('score', { ascending: false }).limit(100);
    if (domain) q = db.from('agent_capabilities').select('*').eq('domain', domain).order('score', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) return fail(res, 500, 'capabilities_failed', error.message);
    return res.json({ domain, leaderboard: data ?? [] });
  } catch (e: any) { return fail(res, 500, 'capabilities_failed', e?.message); }
});

router.get('/capabilities/:agent', async (req: Request, res: Response) => {
  const agent = String(req.params.agent);
  try {
    const { data, error } = await db.from('agent_capabilities').select('*').eq('agent_name', agent).order('domain');
    if (error) return fail(res, 500, 'capabilities_failed', error.message);
    if (!data || data.length === 0) return fail(res, 404, 'agent_not_found', agent);
    const unlocked_domains = data.filter((d: any) => d.unlocked).map((d: any) => d.domain);
    return res.json({ agent_name: agent, domains: data, unlocked_domains });
  } catch (e: any) { return fail(res, 500, 'capabilities_failed', e?.message); }
});

// ---------------------------------------------------------------- Phase 4: collaboration DNA (read)
router.get('/dna/graph', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await db
      .from('collaboration_dna')
      .select('agent_name, mentor_agents, verified_agents, bft_participation_count, hal_catch_rate, lineage_depth, capability_domains');
    if (error) return fail(res, 500, 'dna_failed', error.message);
    const rows = (data ?? []) as any[];
    const nodes = rows.map((d) => ({
      id: d.agent_name,
      lineage_depth: d.lineage_depth,
      bft_participation: d.bft_participation_count,
      hal_catch_rate: d.hal_catch_rate,
      domains: d.capability_domains,
    }));
    const edges: any[] = [];
    for (const d of rows) {
      for (const m of d.mentor_agents ?? []) edges.push({ from: m, to: d.agent_name, type: 'mentorship' });
      for (const v of d.verified_agents ?? []) edges.push({ from: d.agent_name, to: v, type: 'verification' });
    }
    return res.json({ nodes, edges });
  } catch (e: any) { return fail(res, 500, 'dna_failed', e?.message); }
});

router.get('/dna/:agent', async (req: Request, res: Response) => {
  const agent = String(req.params.agent);
  try {
    const { data, error } = await db.from('collaboration_dna').select('*').eq('agent_name', agent).maybeSingle();
    if (error) return fail(res, 500, 'dna_failed', error.message);
    if (!data) return fail(res, 404, 'agent_not_found', agent);
    return res.json(data);
  } catch (e: any) { return fail(res, 500, 'dna_failed', e?.message); }
});

// ---------------------------------------------------------------- Phase 5: x402 payment gate
router.post('/x402-gate/authorize', async (req: Request, res: Response) => {
  const { agent, transaction_type, amount } = req.body ?? {};
  if (!agent || typeof agent !== 'string') return fail(res, 400, 'invalid_agent', 'agent is required');
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return fail(res, 400, 'invalid_amount', 'amount must be a number');
  try {
    const decision = await checkTransactionAuthority({
      agent,
      transaction_type: String(transaction_type ?? 'transfer'),
      amount: amt,
    });
    return res.status(decision.authorized ? 200 : 403).json(decision);
  } catch (e: any) { return fail(res, 500, 'x402_authorize_failed', e?.message); }
});

router.get('/x402-gate/limits/:agent', async (req: Request, res: Response) => {
  const agent = String(req.params.agent);
  try {
    const ctx = await loadAuthorityContext(agent);
    const limit = limitForTier(ctx.tier);
    return res.json({
      agent_name: agent,
      tier: ctx.tier,
      limits: limit,
      daily_used: ctx.daily_used,
      daily_remaining: Math.max(0, limit.daily - ctx.daily_used),
      stake_available: ctx.stake_available,
      open_disputes: ctx.open_disputes,
    });
  } catch (e: any) { return fail(res, 500, 'x402_limits_failed', e?.message); }
});

router.get('/x402-gate/history/:agent', async (req: Request, res: Response) => {
  const agent = String(req.params.agent);
  try {
    const { data, error } = await db
      .from('x402_payment_gates')
      .select('*')
      .eq('agent_name', agent)
      .order('requested_at', { ascending: false })
      .limit(100);
    if (error) return fail(res, 500, 'x402_history_failed', error.message);
    return res.json({ agent_name: agent, gates: data ?? [] });
  } catch (e: any) { return fail(res, 500, 'x402_history_failed', e?.message); }
});

// ---------------------------------------------------------------- Phase 6: disputes (read)
router.get('/disputes', async (req: Request, res: Response) => {
  const status = req.query.status ? String(req.query.status) : null;
  try {
    let q = db.from('dispute_claims').select('*').order('filed_at', { ascending: false }).limit(100);
    if (status) q = db.from('dispute_claims').select('*').eq('status', status).order('filed_at', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) return fail(res, 500, 'disputes_failed', error.message);
    return res.json({ disputes: data ?? [] });
  } catch (e: any) { return fail(res, 500, 'disputes_failed', e?.message); }
});

router.get('/disputes/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  try {
    const { data, error } = await db.from('dispute_claims').select('*').eq('id', id).maybeSingle();
    if (error) return fail(res, 500, 'disputes_failed', error.message);
    if (!data) return fail(res, 404, 'dispute_not_found', id);
    return res.json(data);
  } catch (e: any) { return fail(res, 500, 'disputes_failed', e?.message); }
});

// ---------------------------------------------------------------- Phase 7: staking (read/write)
router.get('/staking/:agent', async (req: Request, res: Response) => {
  const agent = String(req.params.agent);
  try {
    const { data, error } = await db
      .from('staking_deposits')
      .select('*')
      .eq('agent_name', agent)
      .order('staked_at', { ascending: false });
    if (error) return fail(res, 500, 'staking_failed', error.message);
    const rows = (data ?? []) as any[];
    const total_active_usdc = rows
      .filter((d) => d.status === 'active')
      .reduce((s, d) => s + Number(d.amount_usdc ?? 0), 0);
    return res.json({ agent_name: agent, total_active_usdc, deposits: rows });
  } catch (e: any) { return fail(res, 500, 'staking_failed', e?.message); }
});

router.post('/staking/deposit', async (req: Request, res: Response): Promise<void> => {
  const { agent, amount, target_model, dimension } = req.body ?? {};
  if (!agent || typeof agent !== 'string') {
    fail(res, 400, 'invalid_agent', 'agent is required');
    return;
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    fail(res, 400, 'invalid_amount', 'amount must be positive');
    return;
  }
  try {
    const shortId = agent.replace(/^trinity-/i, '').toUpperCase();
    const { data, error } = await db.from('agent_stakes').insert({
      staker_agent: shortId,
      target_model: target_model ?? 'default',
      dimension: dimension ?? 'general',
      stake_amount: Math.round(amt * 1_000_000), // convert to micro-USDC
      status: 'active',
      created_at: new Date().toISOString()
    }).select('*').single();
    if (error) {
      fail(res, 500, 'staking_deposit_failed', error.message);
      return;
    }
    res.json({ ok: true, stake: data });
  } catch (e: any) {
    fail(res, 500, 'staking_deposit_failed', e?.message);
  }
});

router.post('/staking/sponsor', async (req: Request, res: Response): Promise<void> => {
  const { sponsor_agent, sponsored_agent, collateral_usdc } = req.body ?? {};
  if (!sponsor_agent || typeof sponsor_agent !== 'string') {
    fail(res, 400, 'invalid_sponsor_agent', 'sponsor_agent is required');
    return;
  }
  if (!sponsored_agent || typeof sponsored_agent !== 'string') {
    fail(res, 400, 'invalid_sponsored_agent', 'sponsored_agent is required');
    return;
  }
  const collateral = Number(collateral_usdc);
  if (!Number.isFinite(collateral) || collateral <= 0) {
    fail(res, 400, 'invalid_collateral', 'collateral_usdc must be positive');
    return;
  }
  try {
    const sponsorShort = sponsor_agent.replace(/^trinity-/i, '').toUpperCase();
    const sponsoredShort = sponsored_agent.replace(/^trinity-/i, '').toUpperCase();

    // Query repid of the sponsor
    const { data: sponsorAgent } = await db.from('repid_agents').select('current_repid').eq('agent_name', sponsor_agent).maybeSingle();
    const sponsorRepid = sponsorAgent?.current_repid ?? 0;

    const { data, error } = await db.from('sponsorship_records').insert({
      sponsor_agent: sponsorShort,
      sponsored_agent: sponsoredShort,
      collateral_usdc: collateral,
      granted_authority_usdc: collateral / 3, // 3:1 ratio
      collateral_ratio: 3,
      sponsor_repid_at_start: sponsorRepid,
      status: 'active',
      created_at: new Date().toISOString()
    }).select('*').single();
    if (error) {
      fail(res, 500, 'sponsorship_failed', error.message);
      return;
    }
    res.json({ ok: true, sponsorship: data });
  } catch (e: any) {
    fail(res, 500, 'sponsorship_failed', e?.message);
  }
});

// ---------------------------------------------------------------- Phase 8: ZKP routing
router.get('/zkp/config', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await db.from('zkp_routing_config').select('*').eq('active', true).order('proof_type');
    if (error) return fail(res, 500, 'zkp_config_failed', error.message);
    return res.json({ routes: data ?? [] });
  } catch (e: any) { return fail(res, 500, 'zkp_config_failed', e?.message); }
});

router.post('/zkp/route', async (req: Request, res: Response) => {
  const proof_type = req.body?.proof_type;
  if (!proof_type || typeof proof_type !== 'string') return fail(res, 400, 'invalid_proof_type', 'proof_type is required');
  try {
    const { data, error } = await db
      .from('zkp_routing_config')
      .select('*')
      .eq('proof_type', proof_type)
      .eq('active', true)
      .maybeSingle();
    if (error) return fail(res, 500, 'zkp_route_failed', error.message);
    if (!data) return fail(res, 404, 'proof_type_not_routable', proof_type);
    const cfg: any = data;
      // S-ONCHAIN Phase 3: classify + log fast vs heavy decision (per proof request, for audit)
      const routeTo = cfg.zkp_system || ((cfg.sensitivity || 0.5) > 0.6 ? 'plonky3_stark' : 'fast_groth16');
      console.log(\"[ZKP Route] ${cfg.proof_type} sens=${cfg.sensitivity} reg=${cfg.regulatory_tag||'none'} -> ${routeTo}\");
      // use routeTo below
    return res.json({
      proof_type: cfg.proof_type,
      route_to: cfg.zkp_system,
      sensitivity: cfg.sensitivity,
      pre_stageable: cfg.pre_stageable,
      max_frequency_per_day: cfg.max_frequency_per_day,
      estimated_proof_time_ms: cfg.avg_proof_time_ms,
      gas_cost_estimate: cfg.gas_cost_estimate,
    });
  } catch (e: any) { return fail(res, 500, 'zkp_route_failed', e?.message); }
});

export default router;

