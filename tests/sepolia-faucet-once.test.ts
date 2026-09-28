import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('sepolia-faucet-once', () => {
  const script = path.join(__dirname, '..', 'scripts', 'sepolia-faucet-once.mjs');

  it('exits 0 when DRY_RUN is 1 and the file has no private key', () => {
    const src = readFileSync(script, 'utf8');
    expect(src).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(src).not.toMatch(/PRIVATE_KEY/i);
    expect(src).not.toContain('sendTransaction');
    expect(src).not.toContain('eth_sendTransaction');
    expect(src).not.toMatch(/https?:\/\//);

    const run = spawnSync(process.execPath, [script], {
      env: { DRY_RUN: '1' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('sends_eth\tfalse');
    expect(run.stdout).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
