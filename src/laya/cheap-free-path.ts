/**
 * Cheap Laya stays on the free path. Anything else is refused.
 * No fetch and no paid host.
 */

const FREE = ['groq', 'cerebras', 'postcard'] as const;

export interface LayaCheapPath {
  route: 'cheap' | 'refused';
  provider: string | null;
}

export function layaCheapFreePath(provider: string): LayaCheapPath {
  const name = provider.trim().toLowerCase();
  if ((FREE as readonly string[]).includes(name)) {
    return { route: 'cheap', provider: name };
  }
  return { route: 'refused', provider: null };
}
