// Public ERC-8004 agent registration file surface.
//
// Route (mounted at /api/v1 in src/index.ts):
//   GET /api/v1/agents/:id/registration.json
//     Spec-compliant ERC-8004 agent registration file (the off-chain JSON
//     pointed to by the agent's tokenURI on IdentityRegistry). :id is the
//     agent UUID or its exact agent_name (minted token URIs carry names).
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
        const result = await fetchAndGenerateRegistrationFile(
          supabase,
          String(req.params.id)
        );
        if (result.status === 'ambiguous') {
          res.status(409).json({
            error: 'ambiguous_name',
            agent_id: req.params.id,
            detail: 'More than one agent has this name. Use the agent UUID.',
          });
          return;
        }
        if (result.status === 'not_found') {
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
        res.status(200).json(result.file);
      } catch (e: unknown) {
        // Log the cause; answer a fixed string. A database message is not for anonymous callers.
        console.error('[agents-registration] failed:', e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: 'registration_file_generation_failed' });
      }
    }
  );

  return router;
}
