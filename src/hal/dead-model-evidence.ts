/**
 * dead-model-evidence.ts — decide "is this model dead?" from OUR OWN call ledger, not from a list
 * someone edited.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS REPLACES A HAND-MAINTAINED LIST
 * ════════════════════════════════════════════════════════════════════════════════
 * `src/hal/retired-models.ts` is a literal array of dead model ids. It works, and it is the reason
 * the quorum stopped burning a request per fact-check on an archived model. But it has two defects
 * that no amount of care fixes, because they are structural:
 *
 *   1. IT ONLY LEARNS WHEN A HUMAN NOTICES. Four vendor retirements have now been caught by a
 *      person reading production JSON and editing a string. Each one shipped a release.
 *   2. IT CANNOT UN-LEARN. The list is our belief about a vendor, and beliefs go stale in BOTH
 *      directions. When an account regains access to a model — a new key, a new org, a plan
 *      change — the static list keeps refusing it until someone opens a PR to delete the row.
 *      That is a code change to undo a fact that changed outside the code.
 *
 * (2) is not hypothetical: it is the live case that prompted this module. An account was issued a
 * new key that DOES list `zai-glm-4.7`, while this repo had just shipped that id as retired on the
 * strength of the previous key's 404s. Both facts were true, about different credentials. A static
 * list cannot represent that, and the workaround was an env flag to override our own guard.
 *
 * The ledger can. `llm_call_log` records what actually happened on the credential in use, so the
 * answer self-heals the moment reality changes: one success un-kills a model, with no deploy.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS DEATH — AND WHAT MUST NEVER
 * ════════════════════════════════════════════════════════════════════════════════
 * MEASURED against 30 days of this system's own failures. The model-death shapes are:
 *
 *   HTTP 404  "Model zai-glm-4.7 is archived and unavailable"        type: model_archived_error
 *   HTTP 404  "The model `llama-3.1-8b-instant` does not exist..."   groq
 *   HTTP 404  "This model models/gemini-2.0-flash is no longer available"
 *   HTTP 404  "Model does not exist or you do not have access to it" type: not_found_error
 *
 * The far more COMMON failures in the same table are none of these, and misreading any of them as
 * death would drop a healthy model out of the quorum — turning a transient squeeze into a
 * self-inflicted permanent outage:
 *
 *   HTTP 429  rate limit          (2768 + 780 + 82 + ... rows — by far the biggest bucket)
 *   HTTP 402  out of credits      (414 rows)
 *   HTTP 401  bad key             (140 rows)
 *   timeout / fetch failed        (445 rows)
 *   "empty content"               (461 rows — the model ANSWERED, we could not parse it)
 *
 * So the classifier is deliberately narrow: a 404-shaped, model-named refusal and nothing else.
 * When in doubt it returns UNKNOWN, and UNKNOWN never removes a model from the quorum.
 */

import { db } from '../db';

/** How a model is doing on the credential we are actually using. Three outcomes, never two. */
export type ModelLiveness =
  /** Recent calls prove it answers. Overrides any static retired-list entry. */
  | 'LIVE'
  /** Enough 404-shaped refusals, and zero successes, to call it gone on this credential. */
  | 'DEAD'
  /** Not enough evidence either way — never tried, or only ambiguous failures (429/402/401/timeout). */
  | 'UNKNOWN';

export interface ModelEvidence {
  provider: string;
  model: string;
  successes: number;
  /** 404-shaped, model-named refusals only. Rate limits and credit failures are NOT counted here. */
  not_found: number;
  /** Everything else that failed: 429, 402, 401, timeouts, unparseable content. */
  other_failures: number;
  liveness: ModelLiveness;
  /** Safe to log — redacted upstream by fact-check's redactProviderError before it reaches the DB. */
  sample_error?: string;
}

/**
 * A single 404 is not proof. Two independent 404s with no offsetting success is, because the
 * failure mode being detected is total (a retired id 404s on EVERY call — that is what the ledger
 * shows for all four retirements) rather than intermittent. Set low deliberately: the cost of
 * calling a dead model dead one call late is a wasted request; the cost of never calling it is the
 * bug this whole module exists to fix.
 */
export const MIN_NOT_FOUND_FOR_DEAD = 2;

/** Only recent history decides. A model retired-then-restored must not be condemned by August. */
export const EVIDENCE_WINDOW_HOURS = Number(process.env.HAL_DEAD_MODEL_WINDOW_HOURS) || 72;

/**
 * Does this error message say THE MODEL IS GONE, as opposed to any other kind of failure?
 *
 * Exported because it is the load-bearing judgement in this file and it is worth testing directly
 * against real ledger strings rather than only through the aggregate.
 */
export function isModelNotFoundError(message: string | null | undefined): boolean {
  const m = String(message ?? '');
  if (!m) return false;
  // Rate/credit/auth failures are checked FIRST and win. A 429 body can mention the model by name
  // ("Rate limit reached for model `llama-3.1-8b-instant`"), so a naive model-name match would
  // classify the single most common failure in the table as death and empty the quorum under
  // exactly the load that causes rate limiting. This ordering is the guard against that.
  if (/\b(429|402|401|403)\b/.test(m)) return false;
  if (/rate.?limit|too.?many.?requests|quota|insufficient|credit|invalid api key|authentication/i.test(m)) return false;
  if (/timeout|timed out|fetch failed|econnrefused|enotfound|socket/i.test(m)) return false;
  if (/empty content/i.test(m)) return false; // the model answered; our parser did not like it

  // What is left: the four measured death shapes.
  //
  // THE STATUS MUST BE THE STATUS, not the digits appearing anywhere. A bare /\b404\b/ was the
  // first version here and it is too broad to trust: these messages carry arbitrary upstream JSON,
  // so a token count, a byte length, an org id or a request id containing 404 would be read as a
  // retirement and silently drop a healthy model out of the quorum. The ledger already holds a
  // 402 body reading "You requested up to 512 tokens" — a number in exactly that position. Anchor
  // on the `HTTP 404` prefix the logger itself writes (`HTTP ${res.status}:`, sometimes vendor-
  // prefixed as `Groq HTTP 404:` or `Groq HTTP error: 404`) and on the vendors' own typed codes.
  return (
    /model_archived_error|not_found_error/i.test(m) ||
    /\bHTTP\s+(?:error:\s*)?404\b/i.test(m) ||
    /"code"\s*:\s*"?404"?/.test(m) ||
    /is archived and unavailable/i.test(m) ||
    /no longer available/i.test(m) ||
    /model .*does not exist/i.test(m)
  );
}

/** Classify one provider+model's window of calls. Pure — the DB read is the caller's job. */
export function classifyEvidence(e: Omit<ModelEvidence, 'liveness'>): ModelLiveness {
  // A SUCCESS ANYWHERE IN THE WINDOW WINS, unconditionally. This is the un-learn path: the moment a
  // new key can reach a previously-archived model, one answered call revives it with no deploy and
  // no PR. It also means a model cannot be condemned by errors that predate a credential change.
  if (e.successes > 0) return 'LIVE';
  if (e.not_found >= MIN_NOT_FOUND_FOR_DEAD) return 'DEAD';
  return 'UNKNOWN';
}

/** Cache, refreshed on the same cadence as the model catalog. Empty ⇒ nothing is claimed dead. */
let evidenceCache: { rows: ModelEvidence[]; refreshed_at: string | null } = { rows: [], refreshed_at: null };

export function getCachedEvidence(): { rows: ModelEvidence[]; refreshed_at: string | null } {
  return evidenceCache;
}

/** Test seam, and the way a caller asserts the empty-cache (nothing-claimed-dead) behavior. */
export function setCachedEvidence(next: { rows: ModelEvidence[]; refreshed_at: string | null }): void {
  evidenceCache = next;
}

/**
 * Read the window from `llm_call_log` and recompute liveness for every provider+model seen.
 *
 * Bounded by construction: MEASURED 2026-08-28, this table takes ~57 rows and 8 provider|model
 * pairs per 24h, so a windowed select is a small read at a 30-minute cadence. The explicit
 * `limit` is not tuning — it is the guard that keeps this a small read if volume grows by three
 * orders of magnitude, since a monitor that can itself become the load is not a monitor.
 *
 * Never throws. A DB failure leaves the previous cache in place and claims nothing new.
 */
export async function refreshDeadModelEvidence(windowHours = EVIDENCE_WINDOW_HOURS): Promise<ModelEvidence[]> {
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  try {
    const { data, error } = await db
      .from('llm_call_log')
      .select('provider, model, status, error_message')
      .gte('created_at', since)
      .limit(20_000);
    if (error) {
      console.error('[hal] dead-model-evidence: query failed:', error.message);
      return evidenceCache.rows;
    }

    const acc = new Map<string, ModelEvidence>();
    for (const r of (data ?? []) as Array<{ provider: string; model: string; status: string; error_message: string | null }>) {
      if (!r?.provider || !r?.model) continue;
      const key = `${r.provider}|${r.model}`;
      const cur =
        acc.get(key) ??
        ({ provider: r.provider, model: r.model, successes: 0, not_found: 0, other_failures: 0, liveness: 'UNKNOWN' } as ModelEvidence);
      if (r.status === 'success') cur.successes += 1;
      else if (isModelNotFoundError(r.error_message)) {
        cur.not_found += 1;
        cur.sample_error ??= String(r.error_message ?? '').slice(0, 160);
      } else cur.other_failures += 1;
      acc.set(key, cur);
    }

    const rows = [...acc.values()].map((e) => ({ ...e, liveness: classifyEvidence(e) }));
    evidenceCache = { rows, refreshed_at: new Date().toISOString() };

    const dead = rows.filter((r) => r.liveness === 'DEAD');
    if (dead.length > 0) {
      console.warn(
        `[hal] dead-model-evidence: ${dead.length} model(s) MEASURED DEAD in the last ${windowHours}h ` +
          `[${dead.map((d) => `${d.provider}/${d.model} (${d.not_found}x not-found, 0 success)`).join(', ')}]. ` +
          `They will be excluded from the quorum and replaced from the live catalog where one is available.`,
      );
    }
    return rows;
  } catch (e) {
    console.error('[hal] dead-model-evidence: refresh threw:', (e as Error)?.message ?? e);
    return evidenceCache.rows;
  }
}

/** Ledger verdict for one provider+model. UNKNOWN when we have not called it recently. */
export function livenessOf(provider: string, model: string): ModelLiveness {
  const hit = evidenceCache.rows.find(
    (r) => r.provider.toLowerCase() === provider.toLowerCase() && r.model === model,
  );
  return hit?.liveness ?? 'UNKNOWN';
}

/**
 * Has the ledger MEASURED this model dead on the credential in use?
 *
 * Deliberately narrower than "not known to be live": only a DEAD verdict excludes a model. UNKNOWN
 * must never exclude, or a model we have simply not tried yet could never get its first call — the
 * cold-start deadlock that would make this module unable to ever adopt a new model.
 */
export function isMeasuredDead(provider: string, model: string): boolean {
  return livenessOf(provider, model) === 'DEAD';
}
