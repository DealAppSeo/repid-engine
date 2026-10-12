/**
 * faucet-providers.test.ts — pins the faucet PROVIDER LIST the engine serves.
 *
 * GET /api/v1/faucet/info serves src/config/faucet.ts's source list to every surface
 * (the trustshell /faucet page is engine-driven, so it inherits this list rather than
 * hardcoding its own). The existing faucet-route.test only asserts the list is non-empty
 * and well-shaped — a provider could be dropped and both suites would stay green. This
 * guard pins that the two Base-Sepolia funding sources Sean asked for, Coinbase and
 * Alchemy, are present in the served list, and re-asserts the surface stays read-only:
 * info/links only, never dispenses, no write verb.
 *
 * Read-only: no writes, no keys, no tx. No mocked RPC needed — /faucet/info is config-
 * driven and never touches the chain (only /faucet/balance does, covered by faucet-route).
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import express from 'express';
import request from 'supertest';
import faucetRouter from '../src/routes/faucet';

function makeApp() {
  const app = express();
  app.use('/api/v1', faucetRouter);
  return app;
}

interface Faucet {
  name: string;
  url: string;
  assets: string[];
  note?: string;
}

describe('GET /api/v1/faucet/info — provider list', () => {
  it('serves Base Sepolia (testnet 84532), never mainnet', async () => {
    const res = await request(makeApp()).get('/api/v1/faucet/info');
    expect(res.status).toBe(200);
    expect(res.body.chain_id).toBe(84532); // Base Sepolia testnet
  });

  it('includes a Coinbase Base Sepolia faucet entry (info/link only)', async () => {
    const res = await request(makeApp()).get('/api/v1/faucet/info');
    const faucets: Faucet[] = res.body.faucets;
    const coinbase = faucets.find((f) => /coinbase/i.test(f.name) && /coinbase\.com/i.test(f.url));
    expect(coinbase).toBeDefined();
    expect(coinbase!.url).toMatch(/^https:\/\//);
    // The entry is scoped to Base Sepolia (testnet), in its name or URL.
    expect(/sepolia/i.test(coinbase!.name) || /sepolia/i.test(coinbase!.url)).toBe(true);
    expect(coinbase!.assets).toContain('ETH');
  });

  it('includes an Alchemy Base Sepolia faucet entry (info/link only)', async () => {
    const res = await request(makeApp()).get('/api/v1/faucet/info');
    const faucets: Faucet[] = res.body.faucets;
    const alchemy = faucets.find((f) => /alchemy/i.test(f.name) && /alchemy\.com/i.test(f.url));
    expect(alchemy).toBeDefined();
    expect(alchemy!.url).toMatch(/^https:\/\//);
    expect(/sepolia/i.test(alchemy!.name) || /sepolia/i.test(alchemy!.url)).toBe(true);
    expect(alchemy!.assets).toContain('ETH');
  });

  it('is info/links only — never dispenses and exposes no write verb', async () => {
    const res = await request(makeApp()).get('/api/v1/faucet/info');
    expect(res.body.dispenses).toBe(false);
    expect(res.body).not.toHaveProperty('tx_hash');
    expect(res.body).not.toHaveProperty('dispensed');
    // Every served entry is an external link we point the user at — not something we hand out.
    for (const f of res.body.faucets as Faucet[]) {
      expect(f.url).toMatch(/^https:\/\//);
    }
    // There is no dispense verb on the faucet surface at all.
    expect((await request(makeApp()).post('/api/v1/faucet/dispense')).status).toBe(404);
    expect((await request(makeApp()).post('/api/v1/faucet/info')).status).toBe(404);
  });
});
