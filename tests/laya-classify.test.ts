import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classify } from '../src/laya/classify';

describe('laya classify', () => {
  it('routes blank and questions to ask, heavy notes to escalate, and the rest to cheap', () => {
    expect(classify('hello', () => 0).route).toBe('cheap');
    expect(classify('  ', () => 0).route).toBe('ask');
    expect(classify('what is the quorum?', () => 0).route).toBe('ask');
    expect(classify('attest this claim', () => 0).route).toBe('escalate');
    expect(classify('x'.repeat(281), () => 0).route).toBe('escalate');
  });

  it('reports local latency in milliseconds', () => {
    const times = [10, 14];
    const out = classify('hello', () => times.shift() ?? 14);
    expect(out.latency_ms).toBe(4);
    expect(out.route).toBe('cheap');
  });

  it('does not call a paid API', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'laya', 'classify.ts'), 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('axios');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('openai');
    expect(src).not.toContain('anthropic');
  });
});
