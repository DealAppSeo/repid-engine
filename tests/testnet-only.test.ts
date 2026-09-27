import { readFileSync } from 'node:fs';
import path from 'node:path';
import { shadowHumanPath } from '../src/services/human-path-shadow';
import { testnetOnly } from '../src/services/testnet-only';

describe('testnet-only', () => {
  it('records Base Sepolia and does not send ETH', () => {
    const row = testnetOnly();
    expect(row).toEqual({
      chain_id: 84532,
      network: 'base-sepolia',
      sends_eth: false,
      applied: false,
      persisted: false,
      reason: 'testnet_record_only',
    });
    expect(testnetOnly(1).sends_eth).toBe(false);
    expect(testnetOnly(1).applied).toBe(false);
    expect(testnetOnly(1).network).toBe('refused');
  });

  it('leaves the human path unapplied', () => {
    const body = shadowHumanPath();
    expect(body.applied).toBe(false);
    expect(body.testnet_tokens.sends_eth).toBe(false);
    expect(body.testnet_tokens.dispenses).toBe(false);
    expect(body.testnet_tokens.chain_id).toBe(84532);
    const src = readFileSync(path.join(__dirname, '..', 'src', 'services', 'testnet-only.ts'), 'utf8');
    expect(src).not.toContain('sendTransaction');
    expect(src).not.toContain('eth_send');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('ethers');
  });
});
