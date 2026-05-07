import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const adminCapsRouter = Router();

adminCapsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(503).json({ error: 'Admin not configured' });
    return;
  }
  const reqKey = req.headers['x-admin-key'];
  if (reqKey !== adminKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid admin key' });
    return;
  }
  next();
});

adminCapsRouter.get('/', async (req: Request, res: Response) => {
  const { data, error } = await db.from('llm_provider_caps').select('*').order('provider');
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});

adminCapsRouter.post('/reset-month', async (req: Request, res: Response) => {
  const { error } = await db
    .from('llm_provider_caps')
    .update({ 
      current_month_spent_usd: 0, 
      hard_disabled: false, 
      last_reset_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .neq('provider', 'never_matches'); // updates all rows

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, message: 'Monthly spend reset' });
});

adminCapsRouter.post('/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider;
  const updates: any = {};
  if (req.body.monthly_limit_usd !== undefined) updates.monthly_limit_usd = req.body.monthly_limit_usd;
  if (req.body.hard_disabled !== undefined) updates.hard_disabled = req.body.hard_disabled;
  
  updates.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from('llm_provider_caps')
    .update(updates)
    .eq('provider', provider)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json(data);
});
