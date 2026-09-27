import { readFileSync } from 'node:fs';
import path from 'node:path';
import { t12FreeWaveEnabled, t12FreeWaveOrder } from '../src/orchestration/t12-free-wave';

describe('T12 free wave', () => {
  it('is off unless the variable is the exact string true, and never selects anthropic', () => {
    expect(t12FreeWaveEnabled({})).toBe(false);
    expect(t12FreeWaveOrder({})).toEqual([]);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'TRUE' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: '1' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'on' })).toBe(false);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' })).toEqual(['groq', 'cerebras']);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' }).join(' ')).not.toMatch(/anthropic/i);
  });

  it('keeps heartbeat on SQL and points the belt at trustshell status', () => {
    const doc = readFileSync(path.join(__dirname, '..', 'docs', 'T12_BELT.md'), 'utf8');
    const src = readFileSync(path.join(__dirname, '..', 'src', 'orchestration', 't12-free-wave.ts'), 'utf8');
    expect(doc).toContain('trustshell status');
    expect(doc.toLowerCase()).toContain('sql');
    expect(doc.toLowerCase()).not.toContain('api.anthropic.com');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).toContain("raw === 'true'");
  });
});
