import { readFileSync } from 'node:fs';
import path from 'node:path';
import { jevPaidHostGate } from '../src/hal/jev-paid-host';

describe('jev paid host gate', () => {
  it('refuses a job that names a paid host and keeps groq and cerebras', () => {
    expect(jevPaidHostGate({ provider: 'groq' })).toEqual({
      accepted: true,
      reason: 'free_path',
    });
    expect(jevPaidHostGate({ provider: 'cerebras' })).toEqual({
      accepted: true,
      reason: 'free_path',
    });
    expect(jevPaidHostGate({ host: 'api.anthropic.com' })).toEqual({
      accepted: false,
      reason: 'refused_paid_host',
    });
    expect(jevPaidHostGate({ host: 'https://api.openai.com/v1' })).toEqual({
      accepted: false,
      reason: 'refused_paid_host',
    });
    expect(jevPaidHostGate({ provider: 'groq', text: 'see api.anthropic.com' })).toEqual({
      accepted: false,
      reason: 'refused_paid_host',
    });
    expect(jevPaidHostGate({})).toEqual({ accepted: true, reason: 'free_path' });
  });

  it('does not fetch', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'hal', 'jev-paid-host.ts'), 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('providerFetch');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('api.openai.com');
  });
});
