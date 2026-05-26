import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

// Controller endpoints are gated by the human SBT registry (human_sbt_registry),
// NOT by REPID_API_KEYS. Read endpoints require any valid human SBT; privileged
// ops (wake/sprint) require the MASTER SBT.
//
// ⚠️ human_sbt_registry has no "master"/Sean tier today (tiers: institutional /
// qualified_investor / retail). So master identity is env-configured via
// CONTROLLER_MASTER_SBT (a token_id OR a wallet_address). Defaults CLOSED: if the
// env is unset, NO caller is master (privileged ops are blocked). Surfaced to Sean
// (D-046). Squad-scoped permissions are stubbed (master-only) for now.

export interface SbtContext {
  tokenId?: string;
  wallet?: string;
  tier?: string;
  isMaster: boolean;
}

export async function resolveSbt(req: Request): Promise<SbtContext | null> {
  const token = ((req.headers['x-sbt-token'] as string) || '').trim();
  const wallet = ((req.headers['x-sbt-wallet'] as string) || '').trim().toLowerCase();
  if (!token && !wallet) return null;

  const query = token
    ? db.from('human_sbt_registry').select('token_id, wallet_address, qualification_tier').eq('token_id', token).limit(1)
    : db.from('human_sbt_registry').select('token_id, wallet_address, qualification_tier').ilike('wallet_address', wallet).limit(1);

  const { data } = await query;
  const row = data?.[0];
  if (!row) return null;

  const master = (process.env.CONTROLLER_MASTER_SBT || '').trim();
  const isMaster =
    !!master &&
    (row.token_id === master || (row.wallet_address || '').toLowerCase() === master.toLowerCase());

  return { tokenId: row.token_id, wallet: row.wallet_address ?? undefined, tier: row.qualification_tier ?? undefined, isMaster };
}

// Express middleware factory. `{ master: true }` additionally requires the master SBT.
export function requireHumanSbt(opts: { master?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let sbt: SbtContext | null = null;
    try {
      sbt = await resolveSbt(req);
    } catch (e) {
      res.status(500).json({ error: 'SBT lookup failed' });
      return;
    }
    if (!sbt) {
      res.status(401).json({ error: 'Controller requires a human SBT (x-sbt-token or x-sbt-wallet)' });
      return;
    }
    if (opts.master && !sbt.isMaster) {
      res.status(403).json({ error: 'Master SBT required for this operation (set CONTROLLER_MASTER_SBT)' });
      return;
    }
    (req as any).sbt = sbt;
    next();
  };
}
