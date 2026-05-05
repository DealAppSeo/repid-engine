import { createDefaultEmbeddingClient } from '../src/hal/lib/cross-llm/embedding-client';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function runTest() {
  const client = createDefaultEmbeddingClient(process.env.VOYAGE_API_KEY, process.env.VOYAGE_API_KEY ? 'voyage' : undefined);
  console.log('Testing embedding client...');
  
  const text1 = "hello world";
  const text2 = "hello world";
  const text3 = "completely unrelated text about cats";
  
  console.log('Computing embeddings...');
  const emb1 = await client.embed(text1);
  const emb2 = await client.embed(text2);
  const emb3 = await client.embed(text3);
  
  const sim12 = cosineSimilarity(emb1, emb2);
  const sim13 = cosineSimilarity(emb1, emb3);
  
  console.log(`Similarity (hello world, hello world): ${sim12}`);
  console.log(`Similarity (hello world, cats): ${sim13}`);
  
  if (sim12 > 0.99) {
    console.log('[PASS] "hello world" vs "hello world" > 0.99');
  } else {
    console.error('[FAIL] Deterministic similarity failed!');
    process.exit(1);
  }
  
  if (sim13 < 0.5) {
    console.log('[PASS] "hello world" vs "cats" < 0.5');
  } else {
    console.error('[FAIL] Unrelated text similarity is too high!');
    process.exit(1);
  }
  
  console.log('Smoke test passed successfully.');
}

runTest().catch(console.error);
