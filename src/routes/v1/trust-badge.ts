/**
 * TrustBadge endpoints — spec §10.
 *
 * Public and cacheable, because the badge is loaded by third-party sites we do
 * not control. An auth check here would mean the badge silently breaks on every
 * page that embeds it, which is the opposite of reputation portability.
 *
 * CORS is open on the SVG on purpose: it is an <img>, and an <img> that only
 * loads from our own origin is not an embeddable mark.
 */

import { Router, Request, Response } from 'express';
import {
  getBadgeData,
  renderBadgeSvg,
  renderEmbedSnippets,
  type BadgeVariant,
} from '../../services/trust-badge';

export const trustBadgeRouter = Router();

function variantOf(req: Request): BadgeVariant {
  return req.query.variant === 'compact' ? 'compact' : 'full';
}

/**
 * The image. This is the artifact that travels.
 *
 * A missing agent still returns an SVG rather than a 404 image, because a broken
 * image icon on someone's site tells their visitor nothing, while "unknown
 * agent" tells them exactly the right thing.
 */
trustBadgeRouter.get('/badge/:agentId.svg', async (req: Request, res: Response) => {
  const data = await getBadgeData(String(req.params.agentId));
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  // Short cache: a badge showing yesterday's dispute count is a lie with a
  // timestamp. 60s is enough to survive a front-page load, short enough that a
  // slashing event is visible within the minute.
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

  if (!data) {
    return res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="96" role="img" aria-label="Unknown agent">
  <rect width="300" height="96" rx="8" fill="#0f172a"/>
  <rect x="0" y="0" width="4" height="96" rx="2" fill="#64748b"/>
  <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
    <text x="16" y="34" fill="#e2e8f0" font-size="14" font-weight="600">Unknown agent</text>
    <text x="16" y="56" fill="#94a3b8" font-size="12">No such agent is registered.</text>
    <text x="16" y="78" fill="#64748b" font-size="10">trustmarket.dev</text>
  </g>
</svg>`,
    );
  }
  return res.send(renderBadgeSvg(data, variantOf(req)));
});

/** The same facts as JSON, for anything that wants to render its own. */
trustBadgeRouter.get('/badge/:agentId.json', async (req: Request, res: Response) => {
  const data = await getBadgeData(String(req.params.agentId));
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=60');
  if (!data) {
    return res.status(404).json({ error: 'agent_not_found', message: 'No such agent is registered.' });
  }
  return res.json(data);
});

/** Copy-paste embed snippets. The badge only spreads if embedding is trivial. */
trustBadgeRouter.get('/badge/:agentId/embed', async (req: Request, res: Response) => {
  const data = await getBadgeData(String(req.params.agentId));
  if (!data) {
    return res.status(404).json({ error: 'agent_not_found', message: 'No such agent is registered.' });
  }
  res.set('Access-Control-Allow-Origin', '*');
  return res.json({
    agent_id: data.agent_id,
    agent_name: data.agent_name,
    snippets: renderEmbedSnippets(data),
    shows: data.track_record,
    stake: data.stake_label,
    note:
      'The badge renders live from settled contracts and recorded stake. It is not a ' +
      'static image — if the track record changes, every embedded copy changes with it.',
  });
});

export default trustBadgeRouter;
