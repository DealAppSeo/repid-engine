import { db } from '../db';
import { cacheGet, cacheSet } from './dragonfly';
import crypto from 'crypto';

function queryHash(queryText: string): string {
  return crypto.createHash('sha256').update(queryText.trim().toLowerCase()).digest('hex');
}

export async function getCachedSemanticResponse(queryText: string): Promise<string | null> {
  const hash = queryHash(queryText);
  const key = `semantic:${hash}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  // Fallback to Supabase semantic_cache table
  const { data } = await db
    .from('semantic_cache')
    .select('response_text')
    .eq('query_text', queryText.trim().toLowerCase())
    .maybeSingle();

  if (data?.response_text) {
    // Save to Dragonfly with 12 hours TTL
    await cacheSet(key, data.response_text, 43200);
    return data.response_text;
  }
  return null;
}

export async function cacheSemanticResponse(
  queryText: string,
  responseText: string,
  providerUsed: string,
  tokensSaved = 0
): Promise<void> {
  const hash = queryHash(queryText);
  const key = `semantic:${hash}`;
  await cacheSet(key, responseText, 43200);

  // Write through to Supabase semantic_cache
  await db.from('semantic_cache').insert({
    query_text: queryText.trim().toLowerCase(),
    response_text: responseText,
    provider_used: providerUsed,
    tokens_saved: tokensSaved,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 43200 * 1000).toISOString()
  });
}
