// Public ERC-8004 agent registration file surface.
//
// Route (mounted at /api/v1 in src/index.ts):
//   GET /api/v1/agents/:id/registration.json
//     Spec-compliant ERC-8004 agent registration file (the off-chain JSON
//     pointed to by the agent's tokenURI on IdentityRegistry).
//     Public — no auth required. Bypass added in src/middleware/auth.ts.
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAndGenerateRegistrationFile } from '../services/agent-registration-file';

export function createAgentRegistrationRouter(
  supabase: SupabaseClient
): Router {
  const router = Router();

  router.get(
    '/agents/:id/registration.json',
    async (req: Request, res: Response) => {
      try {
        const file = await fetchAndGenerateRegistrationFile(
          supabase,
          String(req.params.id)
        );
        if (!file) {
          res.status(404).json({
            error: 'agent_not_found_or_not_minted',
            agent_id: req.params.id,
            detail:
              'Agent must be minted on the canonical IdentityRegistry (with erc8004_token_id populated) to have a registration file.',
          });
          return;
        }
        // Encourage caching by ERC-8004 indexers.
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(200).json(file);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[agents-registration] failed:', msg);
        res.status(500).json({
          error: 'registration_file_generation_failed',
          message: msg,
        });
      }
    }
  );

  return router;
}
