/**
 * S-CACHE Phase 6 — verification consensus cache. A claim verified >=3 times with a stable verdict
 * and high confidence can short-circuit the LLM call. Conflicting verdicts reset the consensus
 * (don't cache a disputed claim). Keyed by sha256(claim). Graceful no-op without Redis.
 */
import crypto from 'crypto';
import { cacheGet, cacheSet } from './dragonfly';

const VERIFY_CACHE_TTL = Number(process.env.VERIFY_CACHE_TTL ?? 7200); // 2h
const MIN_CONSENSUS = 3;
const MIN_CONFIDENCE = 0.8;

function claimHash(claim: string): string {
  return 'verify:' + crypto.createHash('sha256')
    .update(String(claim).trim().toLowerCase()).digest('hex').substring(0, 24);
}

export interface CachedVerification { verdict: string; cached: true; count: number; confidence: number }

export async function getCachedVerification(claim: string): Promise<CachedVerification | null> {
  const cached = await cacheGet(claimHash(claim));
  if (!cached) return null;
  try {
    const d = JSON.parse(cached);
    if (d.count >= MIN_CONSENSUS && d.confidence > MIN_CONFIDENCE) {
      return { verdict: d.verdict, cached: true, count: d.count, confidence: d.confidence };
    }
  } catch { /* ignore */ }
  return null; // not enough consensus yet
}

export async function recordVerification(claim: string, verdict: string, confidence: number): Promise<void> {
  const key = claimHash(claim);
  const existing = await cacheGet(key);
  if (existing) {
    try {
      const d = JSON.parse(existing);
      if (d.verdict === verdict) {
        d.count += 1;
        d.confidence = (d.confidence * (d.count - 1) + confidence) / d.count;
        await cacheSet(key, JSON.stringify(d), VERIFY_CACHE_TTL);
      } else {
        // Conflicting evidence → reset consensus to this latest verdict.
        await cacheSet(key, JSON.stringify({ verdict, count: 1, confidence }), VERIFY_CACHE_TTL);
      }
      return;
    } catch { /* fall through to fresh write */ }
  }
  await cacheSet(key, JSON.stringify({ verdict, count: 1, confidence }), VERIFY_CACHE_TTL);
}

export { claimHash as __claimHash };
