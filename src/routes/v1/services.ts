import { Router, Request, Response } from 'express';
import { db } from '../../db';

const router = Router();

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
  
  res.json({ data, count, limit: l, offset: o });
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
  res.json(data);
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
