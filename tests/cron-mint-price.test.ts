/**
 * MINT_PRICE_USDC_RAW: the daily living-proof exchange's optional price override.
 *
 * Default-inert: unset means the provider's listed price, exactly as before. Set means a positive
 * integer of raw USDC, capped at 5 USDC. Anything else refuses with a named error before money
 * moves. Exercised in a real node, the way the cron runs it (mint-attestation.mjs self-executes).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIR = join(__dirname, '..', 'scripts', 'cron');
const MODULE = pathToFileURL(join(DIR, 'mint-price.mjs')).href;

function resolve(env: string | undefined, listed: number): { raw: number; source: string } | { error: string } {
  const src = `
    import { resolveMintPrice } from ${JSON.stringify(MODULE)};
    try { process.stdout.write(JSON.stringify(resolveMintPrice(${env === undefined ? 'undefined' : JSON.stringify(env)}, ${listed}))); }
    catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' }));
}

describe('MINT_PRICE_USDC_RAW', () => {
  it('unset: the listed price, and says so', () => {
    expect(resolve(undefined, 100000)).toEqual({ raw: 100000, source: 'agent_services.base_price_usdc_raw' });
  });

  it.each([['1000000', 1000000], ['5000000', 5000000], ['1', 1], [' 1000000 ', 1000000]])(
    'set to %j: that price, from the env', (env, raw) => {
      expect(resolve(env, 100000)).toEqual({ raw, source: 'env MINT_PRICE_USDC_RAW' });
    });

  it('above 5 USDC: refuses, MINT_PRICE_TOO_HIGH', () => {
    expect((resolve('5000001', 100000) as { error: string }).error).toMatch(/^MINT_PRICE_TOO_HIGH:/);
  });

  it.each(['', '0', '-1', '1.5', '1e6', 'abc', '0x10', '01'])('%j: refuses, MINT_PRICE_INVALID', (env) => {
    expect((resolve(env, 100000) as { error: string }).error).toMatch(/^MINT_PRICE_INVALID:/);
  });

  // The contract, the work statement and the signed x402 authorization must carry ONE price. The
  // listed price may now be read only by the resolver; any other read could drift from the override.
  it('the minter reads the listed price only through the resolver', () => {
    const src = readFileSync(join(DIR, 'mint-attestation.mjs'), 'utf8');
    expect(src).toContain("resolveMintPrice(process.env.MINT_PRICE_USDC_RAW, svc.base_price_usdc_raw)");
    expect(src.match(/svc\.base_price_usdc_raw/g)).toHaveLength(1);
  });
});
