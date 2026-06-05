import { db } from '../db';
import { cacheGet, cacheSet } from './dragonfly';

export async function getCachedWisdom(agent: string, promptHash: string): Promise<string | null> {
  const key = `wisdom:${agent.toUpperCase()}:${promptHash}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  // Fallback to Supabase trinity_wisdom_cache
  const { data } = await db
    .from('trinity_wisdom_cache')
    .select('output')
    .eq('agent', agent.toUpperCase())
    .eq('prompt_hash', promptHash)
    .maybeSingle();

  if (data?.output) {
    // Save to Dragonfly with 24 hours TTL
    await cacheSet(key, data.output, 86400);
    return data.output;
  }
  return null;
}

export async function cacheWisdom(agent: string, promptHash: string, output: string): Promise<void> {
  const key = `wisdom:${agent.toUpperCase()}:${promptHash}`;
  await cacheSet(key, output, 86400);

  // Write through to Supabase trinity_wisdom_cache
  await db.from('trinity_wisdom_cache').insert({
    agent: agent.toUpperCase(),
    prompt_hash: promptHash,
    output,
    created_at: new Date().toISOString()
  });
}
