/**
 * S-CACHE — per-IP rate-limit middleware backed by DragonflyDB (persistent, shared across instances).
 *
 * Wraps `checkRateLimit` (src/cache/rate-limiter.ts). Default 10 requests / 24h per IP — the public
 * "ask" budget (matches the TrustChat free-question allowance). Sets X-RateLimit-* headers; returns
 * 429 over the limit. FAILS OPEN when Redis is unavailable (the limiter returns allowed) so an infra
 * blip never blocks real users.
 *
 * NOTE: the user-facing `/chat` lives in trustchat-backend (which has no Redis today). This middleware
 * is applied here to repid-engine's public `/hal/evaluate` surface (trustchat-backend's server path is
 * `/hal/signals`, so this does NOT throttle the HAL pipeline). To rate-limit actual /chat users, add
 * Redis + the same pattern to trustchat-backend.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * TWO CONTROLS, MEASURED 2026-08-25 AGAINST THE LIVE SURFACE
 * ════════════════════════════════════════════════════════════════════════════════
 * A cold run of the published SDK quickstart exhausted the keyless budget in about
 * fifteen minutes of ordinary development and then returned
 * `x-ratelimit-limit: 10, remaining: 0, reset: 55717` — a 15-hour lockout. The
 * quickstart itself makes two calls. Two things were wrong, and they are different
 * problems with different fixes:
 *
 * 1. BYOK DID NOT REACH HERE. `rate-limit.ts` has resolved
 *    `Authorization: Bearer hdg_byok_<key>` to a bypass for a long time, and
 *    `routes/v1/byok.ts` + `services/identity-token.ts` issue those tokens. This
 *    file knew nothing about any of it, so a developer holding a token still hit
 *    the anonymous cap. That is lesson 3 — a mechanism wired at one end only —
 *    and the fix is to consume the resolver that already exists rather than grow
 *    a second one.
 *
 *    CORRECTED 2026-08-25, same day, before any token existed. The first version
 *    of this said a BYOK caller "pays for their own usage" and therefore made
 *    them unmetered. That premise was never checked and is false. This route
 *    reads only `{text, context, strictness, source}` from the body; nothing
 *    under `src/hal/` imports the key-custody service; and the issuance
 *    endpoint's own status response says the token
 *    `does_not_grant: ["access to provider keys"]`. A BYOK token is an IDENTITY,
 *    not a credential, and every evaluation under one spends OUR provider
 *    credits. The name carried an assumption the mechanism never supported.
 *
 *    So BYOK now means "out of the free tier, into your own bounded budget" —
 *    keyed to the token, so a room of testers behind one NAT stop starving each
 *    other, which was the actual problem worth solving.
 *
 * 2. THERE WAS NO CEILING ON THE TOTAL. A per-IP cap bounds each stranger; it
 *    bounds nothing about the bill when there are four hundred strangers. Raising
 *    the per-IP budget for a hackathon — which `HAL_PUBLIC_RATE_LIMIT` already
 *    supports without a deploy — multiplies an unbounded number by a larger one.
 *    The ceiling is what makes raising the per-IP limit safe to do.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE CEILING FAILS CLOSED WHEN THE PER-IP CAP DOES NOT
 * ════════════════════════════════════════════════════════════════════════════════
 * They protect different things, so they fail in different directions, and that
 * asymmetry is deliberate rather than an oversight.
 *
 * The per-IP cap exists to stop one caller monopolising a shared demo. When the
 * counter is unavailable, the cost of guessing wrong is a blocked user, so it
 * keeps its long-standing fail-open behaviour — unchanged by this commit.
 *
 * The ceiling exists to bound spend. **If it cannot count, it cannot bound**, and
 * a spend control that resolves "I don't know" to "go ahead" is not a control.
 * `checkRateLimit` reports `backend: 'fail-open'` when the store is unreachable,
 * so that state is distinguishable from "under budget" and is treated as refusal.
 *
 * This is not a regression: before this commit there was no ceiling at all, so
 * there is no prior behaviour to preserve. It is the new control's own semantics.
 * `HAL_PUBLIC_GLOBAL_FAIL_OPEN=true` opts back out, deliberately and visibly.
 *
 * Neither free-tier control is reached by a BYOK or env-allowlist caller. A BYOK
 * caller meets their OWN daily budget instead, which fails closed for the same
 * reason the ceiling does.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE WORST CASE COSTS, WHICH IS THE ONLY HONEST WAY TO SIZE THIS
 * ════════════════════════════════════════════════════════════════════════════════
 *     evaluations/day  <=  HAL_PUBLIC_GLOBAL_DAILY  +  (live tokens x HAL_BYOK_DAILY)
 *
 * Both terms have to be finite for the sum to be. That is why issuance is capped
 * too (BYOK_MAX_CLAIMABLE, services/identity-token.ts): a per-token budget with
 * unlimited tokens is not a bound, and the claimable mint endpoint is
 * deliberately unauthenticated, so without a cap one shared invite code would
 * reopen everything this file closes.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * CONFIGURATION — all env, no deploy needed to retune
 * ════════════════════════════════════════════════════════════════════════════════
 *   HAL_PUBLIC_RATE_LIMIT        per-IP requests per window   (default 10)
 *   HAL_PUBLIC_RATE_WINDOW_SEC   that window                  (default 86400)
 *   HAL_PUBLIC_GLOBAL_DAILY      free-tier calls/day, ALL IPs (default 2000; 0 disables)
 *   HAL_PUBLIC_GLOBAL_FAIL_OPEN  'true' to serve when uncountable (default: refuse)
 *   HAL_BYOK_DAILY               evaluations/day PER TOKEN    (default 500; 0 = unmetered)
 *
 * The first two are read in src/index.ts and passed in; the rest are read here
 * because nothing else needs them.
 */
import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../cache/rate-limiter';
import { hasValidEnvApiKey } from './env-api-key';
import { resolveByokIdentity } from './rate-limit';

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const fromXff = Array.isArray(xff) ? xff[0] : (typeof xff === 'string' ? xff.split(',')[0] : undefined);
  return (fromXff || req.ip || req.socket?.remoteAddress || 'unknown').trim();
}

/** Free-tier calls per day across every anonymous caller. 0 disables the ceiling. */
function globalDailyCeiling(): number {
  const raw = Number(process.env.HAL_PUBLIC_GLOBAL_DAILY);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2000;
}

/** Serve free traffic when the counter is unreachable? Default NO — see header. */
function ceilingFailsOpen(): boolean {
  return String(process.env.HAL_PUBLIC_GLOBAL_FAIL_OPEN ?? '').trim().toLowerCase() === 'true';
}

/**
 * Daily HAL evaluations per BYOK token. 0 means unmetered, deliberately.
 *
 * 500/day is roughly fifty times the anonymous allowance and far more than a
 * developer integrating the SDK will use — the point is that it is a NUMBER, so
 * total exposure can be computed instead of hoped about:
 *
 *     worst case/day  =  HAL_PUBLIC_GLOBAL_DAILY  +  (live tokens x this)
 *
 * which is why the count of live tokens is itself capped at issuance
 * (BYOK_MAX_CLAIMABLE in services/identity-token.ts). A per-token budget with
 * unlimited tokens bounds nothing.
 */
function byokDailyBudget(): number {
  const raw = Number(process.env.HAL_BYOK_DAILY);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 500;
}

const GLOBAL_WINDOW_SECONDS = 86_400;

export function ipRateLimit(limit = 10, windowSeconds = 86400) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'OPTIONS') return next();
    // Authenticated callers bypass the public per-IP cap. The cap exists to fence
    // the ANONYMOUS demo budget; a request bearing a valid REPID_API_KEYS key is a
    // known, trusted caller, so it is not subject to the free per-IP allowance.
    // This is what lets an authenticated run of the trust-harness E2E demo actually
    // reach the HAL quorum instead of stalling on a 429. Only RELAXES the limit —
    // keyless traffic is unchanged — and only recognises env-allowlist keys.
    if (hasValidEnvApiKey(req.headers)) {
      res.setHeader('X-RateLimit-Bypass', 'api-key');
      return next();
    }

    // A BYOK caller is out of the FREE TIER — neither the anonymous per-IP budget
    // nor the shared ceiling is theirs to consume — but they are not unmetered.
    // They get their own daily budget instead, keyed to the token.
    //
    // The comment that stood here said "a BYOK caller pays for their own usage."
    // That was wrong, and it was the premise the whole bypass rested on. They do
    // not: this route reads only {text, context, strictness, source} from the body
    // and never resolves a caller-supplied provider key, so every BYOK evaluation
    // spends OUR provider credits. Correcting the sentence without correcting the
    // control would have left the bill unbounded.
    //
    // Keyed to the token, not the IP, on purpose: a room of hackathon testers
    // behind one NAT each get their own budget, which is the entire reason to hand
    // out tokens rather than raise the per-IP number.
    try {
      const byok = await resolveByokIdentity(req);
      if (byok.valid) {
        res.setHeader('X-RateLimit-Bucket', 'byok');
        const budget = byokDailyBudget();
        if (budget <= 0) {
          // 0 is a deliberate, visible opt-out into unmetered BYOK. It is not the
          // default, and it is the only way to get there.
          res.setHeader('X-RateLimit-Bypass', 'byok-unmetered');
          return next();
        }

        // `byok.keyId` can be null only if the row was found without an id, which
        // the select makes impossible; the fallback exists so a null could never
        // silently collapse every token into one shared bucket.
        const key = byok.keyId ? `hal:byok:${byok.keyId}` : 'hal:byok:unidentified';
        const b = await checkRateLimit(key, budget, GLOBAL_WINDOW_SECONDS);
        res.setHeader('X-RateLimit-Limit', String(budget));
        res.setHeader('X-RateLimit-Remaining', String(b.remaining));

        if (b.backend === 'fail-open') {
          // Same reasoning as the ceiling below: if it cannot count, it cannot
          // bound, and this is a spend control. A BYOK holder who cannot be
          // metered is not therefore entitled to unlimited spend.
          res.setHeader('X-RateLimit-Byok-State', 'uncountable');
          res.status(503).json({
            error: 'BYOK_BUDGET_UNAVAILABLE',
            message:
              'The usage counter is unavailable, so your token budget cannot be enforced right now. ' +
              'This is temporary — retry shortly.',
            reason: 'usage_counter_unreachable',
          });
          return;
        }
        if (!b.allowed) {
          res.setHeader('X-RateLimit-Byok-State', 'exhausted');
          res.status(429).json({
            // 429, unlike the ceiling's 503: this caller really did spend their
            // own allowance, so saying so is a true statement about them.
            error: 'BYOK_BUDGET_EXHAUSTED',
            message: `This token's daily budget of ${budget} evaluations is spent. It resets daily.`,
            resetIn: b.resetIn,
          });
          return;
        }
        return next();
      }
    } catch {
      // A BYOK lookup failure must not grant a bypass, and must not 500 a request
      // that is still perfectly serviceable as anonymous traffic.
    }

    try {
      const r = await checkRateLimit(`chat:${clientIp(req)}`, limit, windowSeconds);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      res.setHeader('X-RateLimit-Reset', String(r.resetIn));
      if (!r.allowed) {
        res.status(429).json({
          error: 'RATE_LIMITED',
          message: 'Daily limit reached. Try again tomorrow.',
          remaining: r.remaining,
          resetIn: r.resetIn,
        });
        return;
      }

      // The per-IP budget is checked FIRST so that a caller who is already over
      // their own allowance does not consume shared free-tier headroom on the way
      // to being refused. The cost is that a request rejected by the ceiling has
      // still spent one unit of its own per-IP budget — bounded, and the fairer
      // direction of the two.
      const ceiling = globalDailyCeiling();
      if (ceiling > 0) {
        const g = await checkRateLimit('hal:free:global', ceiling, GLOBAL_WINDOW_SECONDS);
        res.setHeader('X-RateLimit-Global-Limit', String(ceiling));
        res.setHeader('X-RateLimit-Global-Remaining', String(g.remaining));

        const uncountable = g.backend === 'fail-open';
        if (uncountable && !ceilingFailsOpen()) {
          res.setHeader('X-RateLimit-Global-State', 'uncountable');
          res.status(503).json({
            error: 'FREE_TIER_UNAVAILABLE',
            // 503, not 429: the caller did nothing wrong and retrying later may
            // well succeed. Saying "you sent too many" would be a false statement
            // about them.
            message:
              'The free-tier usage counter is unavailable, so free capacity cannot be granted right now. ' +
              'Bring your own key to continue without the shared budget.',
            reason: 'usage_counter_unreachable',
          });
          return;
        }
        if (!uncountable && !g.allowed) {
          res.setHeader('X-RateLimit-Global-State', 'exhausted');
          res.status(429).json({
            error: 'FREE_TIER_EXHAUSTED',
            message:
              'The shared free-tier budget for today is spent. It resets daily. ' +
              'Bring your own key for unmetered access.',
            resetIn: g.resetIn,
          });
          return;
        }
      }

      return next();
    } catch {
      // Never block on limiter failure.
      return next();
    }
  };
}
