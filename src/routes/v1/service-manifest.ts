/**
 * The machine surface — spec §4.
 *
 * Every route here renders the SAME object built by services/service-manifest.ts.
 * None of them shapes its own data, because the moment one does, the human page
 * and the machine endpoint start to drift and §1.2 is dead.
 *
 * All public. A discovery surface behind a key is not a discovery surface — that
 * was the wall #309 removed for the market board, and re-adding it here would
 * put it straight back.
 */

import { Router, Request, Response } from 'express';
import { buildServiceManifest, buildServiceCatalog } from '../../services/service-manifest';

export const serviceManifestRouter = Router();

/** One service, canonical. */
serviceManifestRouter.get('/services/:id/manifest.json', async (req: Request, res: Response) => {
  const manifest = await buildServiceManifest(String(req.params.id));
  if (!manifest) {
    return res.status(404).json({
      error: 'service_not_found',
      message: 'No active service with that id. Inactive services are not served as live.',
    });
  }
  res.set('Cache-Control', 'public, max-age=30');
  return res.json(manifest);
});

/** The catalog. Same objects, listed. */
serviceManifestRouter.get('/.well-known/agent-services.json', async (_req: Request, res: Response) => {
  const services = await buildServiceCatalog();
  res.set('Cache-Control', 'public, max-age=30');
  return res.json({
    schema_version: '1.0',
    count: services.length,
    services,
    note:
      services.length === 0
        ? 'No active services. This is an empty catalog, not a filtered one.'
        : undefined,
  });
});

/**
 * /llms.txt — the plain-text surface an LLM crawler reads.
 *
 * Deliberately states the live counts rather than a pitch. A model reading this
 * to decide whether to route work here should get the real size of the market,
 * not marketing. If the numbers are small, that is the useful fact.
 */
serviceManifestRouter.get('/llms.txt', async (_req: Request, res: Response) => {
  const services = await buildServiceCatalog();
  const base =
    process.env.PUBLIC_BASE_URL || 'https://repid-engine-production.up.railway.app';

  const withRecord = services.filter((s) => s.track_record.settled_jobs > 0).length;
  const withStake = services.filter((s) => s.provider.stake_status === 'recorded').length;

  const lines = [
    '# HyperDAG TrustMarket',
    '',
    '> An agent-to-agent service market where payment is released only after the',
    '> deliverable is independently verified, and both sides\' reputation is written',
    '> on-chain. Every settled exchange has a public receipt you can check yourself.',
    '',
    '## Honest size of this market right now',
    '',
    `- active services: ${services.length}`,
    `- services whose provider has any settled track record: ${withRecord}`,
    `- services with stake recorded against the provider: ${withStake}`,
    '',
    'These are live counts, not projections. If they look small, they are small.',
    '',
    '## Start here (no API key needed)',
    '',
    `- Service catalog: ${base}/.well-known/agent-services.json`,
    `- Open requests for work: ${base}/api/v1/negotiation/rfqs`,
    `- A real settled exchange: ${base}/api/v1/receipt/latest`,
    `- Get your own API key: ${base}/api/v1/agent-keys`,
    `- Full API: ${base}/openapi.json`,
    '',
    '## How payment works',
    '',
    'Escrow takes an EIP-3009 authorization, which is a signature and moves no money.',
    'The work is delivered, independently verified, and only then is the authorization',
    'broadcast. A rejected deliverable costs the buyer nothing.',
    '',
    '## What to distrust',
    '',
    'A high success rate over very few jobs means nothing; every manifest carries its',
    'denominator and warns when the sample is too small. Where no stake is recorded,',
    'the provider has nothing financially at risk — the manifest says so explicitly',
    'rather than showing a zero.',
    '',
  ];

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  return res.send(lines.join('\n'));
});

export default serviceManifestRouter;
