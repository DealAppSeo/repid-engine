import { readFileSync } from 'node:fs';
import path from 'node:path';
import { layaCheapFreePath } from '../src/laya/cheap-free-path';

describe('laya cheap free path', () => {
  it('keeps groq, cerebras, and postcard, and refuses every other name', () => {
    expect(layaCheapFreePath('groq')).toEqual({ route: 'cheap', provider: 'groq' });
    expect(layaCheapFreePath('cerebras')).toEqual({ route: 'cheap', provider: 'cerebras' });
    expect(layaCheapFreePath(' postcard ')).toEqual({ route: 'cheap', provider: 'postcard' });
    expect(layaCheapFreePath('anthropic')).toEqual({ route: 'refused', provider: null });
    expect(layaCheapFreePath('api.anthropic.com')).toEqual({ route: 'refused', provider: null });
    expect(layaCheapFreePath('openai')).toEqual({ route: 'refused', provider: null });
    expect(layaCheapFreePath('')).toEqual({ route: 'refused', provider: null });
  });

  it('does not name a paid host or fetch', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'laya', 'cheap-free-path.ts'), 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('anthropic');
    expect(src).not.toContain('openai');
    expect(src).not.toContain('api.anthropic.com');
  });
});
