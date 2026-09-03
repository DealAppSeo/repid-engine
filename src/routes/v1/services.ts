import { Router, Request, Response } from 'express';
import { db } from '../../db';

const router = Router();

type ServiceRow = Record<string, unknown> & { provider_agent_id?: unknown };

/**
 * Attach the provider's identity and live reputation to each service row.
 *
 * `agent_services` stores only `provider_agent_id`, a UUID. A catalog rendered
 * from that alone cannot tell twelve providers of "Constitutional Verification"
 * apart, and a reputation-gated marketplace was not returning the reputation the
 * gate is about — `min_repid_to_purchase` was shipped with nothing to compare it
 * against. This is additive: `provider_agent_id` is untouched, so existing
 * consumers keep working.
 *
 * One batched lookup, not one per row. `provider` is null when the id resolves to
 * no agent, which is honestly "unknown provider" rather than a fabricated zero —
 * a caller must not read a missing reputation as a bad one.
 */
async function withProvider<T extends ServiceRow>(rows: T[] | null): Promise<Array<T & { provider: unknown }>> {
  const list = rows ?? [];
  if (list.length === 0) return [];

  const ids = Array.from(
    new Set(
      list
        .map((r) => (typeof r.provider_agent_id === 'string' ? r.provider_agent_id : null))
        .filter((v): v is string => Boolean(v)),
    ),
  );

  const byId = new Map<string, { agent_name: string | null; current_repid: number | null; tier: string | null }>();
  if (ids.length > 0) {
    const { data: agents } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier')
      .in('id', ids);
    for (const a of (agents ?? []) as Array<Record<string, unknown>>) {
      byId.set(String(a['id']), {
        agent_name: (a['agent_name'] as string | null) ?? null,
        current_repid: (a['current_repid'] as number | null) ?? null,
        tier: (a['tier'] as string | null) ?? null,
      });
    }
  }

  return list.map((r) => ({
    ...r,
    provider:
      typeof r.provider_agent_id === 'string' ? byId.get(r.provider_agent_id) ?? null : null,
  }));
}

router.post('/', async (req: Request, res: Response) => {
  const { provider_agent_id, service_type, service_name, description, base_price_usdc_raw, min_repid_to_purchase, capability_metadata } = req.body;
  if (!provider_agent_id || !service_type || !service_name || base_price_usdc_raw === undefined) {
    return res.status(400).json({ error: 'provider_agent_id, service_type, service_name, and base_price_usdc_raw required' });
  }

  const { data, error } = await db.from('agent_services').insert({
    provider_agent_id,
    service_type,
    service_name,
    description,
    base_price_usdc_raw,
    min_repid_to_purchase: min_repid_to_purchase || 500,
    capability_metadata: capability_metadata || {}
  }).select().single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
});

router.get('/', async (req: Request, res: Response) => {
  const { type, provider, min_price, max_price, min_repid_offered, active_only, limit, offset } = req.query;
  
  let query = db.from('agent_services').select('*', { count: 'exact' });
  
  if (type) query = query.eq('service_type', type);
  if (provider) query = query.eq('provider_agent_id', provider);
  if (min_price) query = query.gte('base_price_usdc_raw', Number(min_price));
  if (max_price) query = query.lte('base_price_usdc_raw', Number(max_price));
  if (min_repid_offered) query = query.lte('min_repid_to_purchase', Number(min_repid_offered));
  
  const isActiveOnly = active_only !== 'false';
  if (isActiveOnly) query = query.eq('active', true);
  
  const l = Number(limit) || 50;
  const o = Number(offset) || 0;
  query = query.range(o, o + l - 1).limit(Math.min(l, 200));

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ data: await withProvider(data), count, limit: l, offset: o });
});

router.get('/categories', async (_req: Request, res: Response) => {
  const { data, error } = await db.from('service_categories').select('*').order('category_name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/:id', async (req: Request, res: Response) => {
  if (req.params.id === 'categories') return; // Handled above
  const { data, error } = await db.from('agent_services').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'Service not found' });
  const [enriched] = await withProvider([data as ServiceRow]);
  res.json(enriched ?? data);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const updates = req.body;
  delete updates.id;
  delete updates.provider_agent_id;
  delete updates.service_type;

  const { data, error } = await db.from('agent_services')
    .update(updates)
    .eq('id', req.params.id)
    .select().single();
    
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const { data, error } = await db.from('agent_services')
    .update({ active: false })
    .eq('id', req.params.id)
    .select().single();
    
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

export default router;
