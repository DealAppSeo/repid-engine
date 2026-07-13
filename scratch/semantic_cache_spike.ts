import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { embedBatch } from '../src/services/graph-rag/embedding-service';

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && process.env[mm[1]!] === undefined) {
      process.env[mm[1]!] = (mm[2] ?? '').replace(/^["']|["']$/g, '');
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main() {
  loadEnv();
  const dbUrl = process.env.SUPABASE_URL;
  const dbKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl || !dbKey) {
    console.error('Missing DB config');
    return;
  }
  const db = createClient(dbUrl, dbKey);

  console.log('Fetching latest 1,000 claims from peer_verification_queue...');
  const { data, error } = await db.from('peer_verification_queue')
    .select('claim_text')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) {
    console.error('DB Error:', error);
    return;
  }

  if (!data || data.length === 0) {
    console.log('No data found');
    return;
  }

  const claims = data.map(r => r.claim_text).filter(Boolean);
  console.log(`Fetched ${claims.length} claims. Computing embeddings...`);

  // Let's batch embed to avoid memory limits or API issues
  const embeddings: number[][] = [];
  const batchSize = 100;
  for (let i = 0; i < claims.length; i += batchSize) {
    const batch = claims.slice(i, i + batchSize);
    console.log(`Embedding batch ${i / batchSize + 1}/${Math.ceil(claims.length / batchSize)}...`);
    const batchEmbeds = await embedBatch(batch);
    embeddings.push(...batchEmbeds);
  }

  console.log('Computing cache hit rate metrics...');
  let exactHits = 0;
  let semanticHits = 0;

  // Track seen texts and their embeddings
  const seenTexts = new Map<string, number>(); // text -> index
  const cacheEmbeddings: number[][] = [];
  const cacheTexts: string[] = [];

  for (let i = 0; i < claims.length; i++) {
    const text = claims[i]!.trim().toLowerCase();
    const emb = embeddings[i]!;

    // 1. Exact match check
    if (seenTexts.has(text)) {
      exactHits++;
    } else {
      seenTexts.set(text, i);
    }

    // 2. Semantic match check (cosine >= 0.92)
    let semHit = false;
    for (let j = 0; j < cacheEmbeddings.length; j++) {
      const sim = cosineSimilarity(emb, cacheEmbeddings[j]!);
      if (sim >= 0.92) {
        semHit = true;
        break;
      }
    }

    if (semHit) {
      semanticHits++;
    } else {
      cacheEmbeddings.push(emb);
      cacheTexts.push(claims[i]!);
    }
  }

  console.log('\n--- RESULTS ---');
  console.log(`Total sample size: ${claims.length}`);
  console.log(`Exact Match Hits: ${exactHits} (${((exactHits / claims.length) * 100).toFixed(2)}%)`);
  console.log(`Semantic Match (cosine >= 0.92) Hits: ${semanticHits} (${((semanticHits / claims.length) * 100).toFixed(2)}%)`);

  // Print top prefixes or common templates
  const prefixes = new Map<string, number>();
  for (const t of claims) {
    const words = t.split(/\s+/);
    const prefix = words.slice(0, 4).join(' ').toLowerCase();
    prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
  }
  const sortedPrefixes = Array.from(prefixes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  console.log('\nTop 10 Query Prefixes (first 4 words):');
  for (const [p, count] of sortedPrefixes) {
    console.log(`- "${p}": ${count} occurrences`);
  }
}

main();
