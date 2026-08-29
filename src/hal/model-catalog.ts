/**
 * model-catalog.ts — ASK THE VENDOR which models this key can reach, instead of hardcoding a guess.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * Every model-death incident in this repo has the same shape, and it has now happened four times:
 *
 *   2026-08-04  gemini-2.0-flash   retired by Google      — quorum silently lost the gemini family
 *   2026-08-16  llama-3.1-8b-instant shut down by Groq    — 404 on every call
 *   2026-08-17  zai-glm-4.7        archived by Cerebras   — 404 on every call
 *   2026-08-27  zai-glm-4.6        chosen from DOCS as 4.7's replacement; never once answered
 *
 * Each time, the fix was a human noticing, reading a vendor page, editing a hardcoded string, and
 * redeploying. The fourth one is the tell: the replacement was picked from documentation rather
 * than measurement, and it was dead on arrival. A process whose repair step is "guess a new id from
 * a docs page" reliably produces dead ids.
 *
 * Meanwhile `src/services/provider-key-probe.ts` has been calling each vendor's `/models` endpoint
 * this whole time — the exact list of what the key can reach — and reading only the HTTP status off
 * it before discarding the body. The answer was already arriving on every probe and nothing parsed
 * it. That is this codebase's recurring defect (a fact recorded where the worker never reads it),
 * and this module is the fix: parse the body, cache it, and let the quorum builder choose from what
 * is really there.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CATALOG IS NECESSARY AND NOT SUFFICIENT — THIS IS MEASURED, NOT CAUTIOUS
 * ════════════════════════════════════════════════════════════════════════════════
 * `fact-check.ts` already records the counter-example, verified 2026-08-04: Google's `/models` list
 * STILL ADVERTISED `gemini-2.0-flash` after every call to it returned 404. So "present in the
 * catalog" does not imply "answers a completion".
 *
 * Therefore the catalog is only half the input. The other half is our OWN ledger — what actually
 * worked when we called it — supplied by `dead-model-evidence.ts`. Selection uses the difference:
 *
 *      reachable  =  what the vendor advertises  MINUS  what we have measured to be dead
 *
 * Neither source alone is trustworthy. The vendor over-reports (stale list); the ledger under-
 * reports (says nothing about a model we have never tried). Together they are correct on both the
 * "quietly retired" and the "advertised but broken" cases, which are the only two that have ever
 * bitten us.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY A BACKGROUND CACHE RATHER THAN A LOOKUP AT BUILD TIME
 * ════════════════════════════════════════════════════════════════════════════════
 * `buildFactCheckProvidersWith()` is SYNCHRONOUS and sits on the live scoring path. Making it async
 * to await a network call would put a vendor's availability in front of every fact-check — turning
 * a provider outage into a HAL latency incident, which is precisely backwards for a module whose
 * job is to survive provider outages.
 *
 * So refresh runs on an interval (mirroring `scoreMonitor` in src/index.ts) and the builder reads a
 * process-local cache synchronously. Consequences, stated plainly rather than discovered later:
 *   - Before the first refresh completes the cache is EMPTY, and an empty cache means the builder
 *     behaves EXACTLY as it does today (static defaults). Not a degraded mode — the current mode.
 *   - A vendor outage during refresh leaves the last good catalog in place, marked with its age.
 *     Stale beats absent: a list from an hour ago is still better evidence than a string typed in
 *     August.
 *   - This never throws. A catalog that can take down the caller is worse than no catalog.
 */

import { PROVIDER_PROBES, probeFor, resolveProbeKey, type ProviderProbe } from '../services/provider-key-probe';

/** Outcome of asking one provider for its model list. Three outcomes, never two. */
export type CatalogStatus =
  /** The provider answered with a parseable list. `models` is authoritative for this key. */
  | 'MEASURED'
  /** No key, unreachable, unparseable, or an unexpected status. `models` is empty and means nothing. */
  | 'NOT_CHECKED';

export interface ProviderCatalog {
  provider: string;
  status: CatalogStatus;
  /** Model ids exactly as the vendor spells them — these are the strings a call must use. */
  models: string[];
  /**
   * Per-1M-token rates for the models whose vendor PUBLISHES them, keyed by model id.
   *
   * Present only where the vendor states a price. A model absent from this map is UNPRICED —
   * unknown, not free. Never default a missing entry to 0: the ledger already had one incident
   * where a fabricated rate reached the cost dashboard, and an assumed zero is the same error
   * pointed the other way (it HIDES spend rather than inventing it). Both were how the invisible
   * frontier-model spend went unnoticed for three weeks.
   */
  pricing?: Record<string, { in: number; out: number }>;
  /** Safe to log: never contains key material. */
  detail: string;
  /** When this entry was fetched. */
  fetched_at: string;
}

export interface ModelCatalog {
  entries: Record<string, ProviderCatalog>;
  refreshed_at: string | null;
}

/**
 * Process-local cache. Deliberately module state rather than a DB read on the hot path: the builder
 * is synchronous and runs per fact-check, so this must be a memory hit or it is not usable there.
 */
let cache: ModelCatalog = { entries: {}, refreshed_at: null };

/** Synchronous read for the quorum builder. An empty catalog is the caller's cue to use its defaults. */
export function getCachedCatalog(): ModelCatalog {
  return cache;
}

/** Test seam. Also lets a caller clear the cache to assert the empty-catalog (today's) behavior. */
export function setCachedCatalog(next: ModelCatalog): void {
  cache = next;
}

/**
 * Extract model ids from a vendor's `/models` body.
 *
 * ONE PARSER, NOT A PER-VENDOR TABLE, because there are only two shapes in the wild and a table
 * would be one more list to maintain — the thing this module exists to stop doing:
 *
 *   OpenAI-compatible  { data:   [ { id: 'llama-3.3-70b' } ] }   groq, cerebras, deepseek, mistral,
 *                                                                openrouter, fireworks, deepinfra,
 *                                                                openai, grok, anthropic
 *   Google / Cohere    { models: [ { name: 'models/gemini-2.5-flash' } ] }
 *
 * Google prefixes ids with `models/`, and the completion endpoint wants them WITHOUT it — a
 * catalog that returned the prefixed form would hand the caller a string that 404s, which is the
 * class of bug this module exists to remove. Stripped here, once, rather than at each call site.
 *
 * Returns [] for anything it does not recognise. An unrecognised body must never be reported as
 * "this provider has no models" — the caller distinguishes the two via `status`, and a MEASURED
 * status is only claimed when at least one id was actually parsed.
 */
export function parseModelIds(body: unknown): string[] {
  const out: string[] = [];
  const b = body as { data?: unknown; models?: unknown };
  const rows = Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : [];
  for (const r of rows) {
    const row = r as { id?: unknown; name?: unknown };
    const raw = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : '';
    const id = raw.replace(/^models\//, '').trim();
    if (id) out.push(id);
  }
  return [...new Set(out)];
}

/**
 * Extract per-model pricing from a vendor's `/models` body, where the vendor publishes it.
 *
 * WHY THIS IS WORTH HAVING. `PRICING_PER_1M_TOKENS` is hand-maintained, so every model nobody has
 * typed a row for ledgers at 0 — and 0 is indistinguishable from free in the stored number. That is
 * how frontier models routed through a gateway logged real token counts against $0.00 for weeks.
 * A vendor that already tells us the price on every catalog refresh is a better source than a human
 * remembering to add a row.
 *
 * SHAPE. OpenRouter (the only catalog in PROVIDER_PROBES that publishes rates today) returns
 * `pricing: { prompt, completion }` as **USD per single token**, as STRINGS:
 *
 *   { data: [ { id: 'qwen/qwen-2.5-72b-instruct', pricing: { prompt: '0.0000004', completion: '0.0000004' } } ] }
 *
 * The billing table is per 1M tokens, hence the 1e6 scaling. Getting that factor wrong by 10^6 is
 * the obvious catastrophic failure here, so `tests/model-catalog-pricing.test.ts` pins a known rate
 * end-to-end rather than testing the parser's arithmetic in isolation.
 *
 * WHAT IS DELIBERATELY EXCLUDED, because each would put a wrong number in the ledger:
 *   - a model with no `pricing` key at all — stays unpriced
 *   - a value that is not a finite non-negative number (null, '', 'N/A', -1)
 * A vendor's explicit `'0'` IS kept: that is the vendor asserting a free tier, which is exactly the
 * `free` vs `unpriced` distinction `cost-class.ts` exists to preserve.
 */
export function parseModelPricing(body: unknown): Record<string, { in: number; out: number }> {
  const out: Record<string, { in: number; out: number }> = {};
  const b = body as { data?: unknown; models?: unknown };
  const rows = Array.isArray(b?.data) ? b.data : Array.isArray(b?.models) ? b.models : [];

  const perMillion = (v: unknown): number | null => {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    // Rounded to 6dp — the same precision `calculateCost` already rounds its output to. Without
    // it, 0.0000004 * 1e6 lands on 0.39999999999999997 and that float noise rides into every
    // stored cost. Six decimal places of a per-1M rate is a millionth of a dollar per million
    // tokens: far below anything that could change a billing decision.
    return Math.round(n * 1_000_000 * 1e6) / 1e6;
  };

  for (const r of rows) {
    const row = r as { id?: unknown; name?: unknown; pricing?: unknown };
    const raw = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : '';
    const id = raw.replace(/^models\//, '').trim();
    if (!id || !row?.pricing || typeof row.pricing !== 'object') continue;
    const pr = row.pricing as { prompt?: unknown; completion?: unknown };
    const inRate = perMillion(pr.prompt);
    const outRate = perMillion(pr.completion);
    if (inRate === null || outRate === null) continue;
    out[id] = { in: inRate, out: outRate };
  }
  return out;
}

/**
 * Fetch one provider's catalog. Never throws; every failure becomes NOT_CHECKED with a reason.
 *
 * `lookup` is injectable for the same reason `resolveProbeKey` takes one — the ops CLI resolves
 * keys through `.env.master` as well as `process.env`.
 */
export async function fetchProviderCatalog(
  probe: ProviderProbe,
  timeoutMs = 12_000,
  lookup?: (name: string) => string | undefined,
): Promise<ProviderCatalog> {
  const fetched_at = new Date().toISOString();
  const base = { provider: probe.provider, models: [] as string[], fetched_at };

  const resolved = resolveProbeKey(probe, lookup);
  if (!resolved) return { ...base, status: 'NOT_CHECKED', detail: 'no key configured' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(probe.url, { headers: probe.headers(resolved.key), signal: ctrl.signal });
    if (!res.ok) {
      // A status alone is a fact about the CREDENTIAL, not about the model list, and
      // `probeProviderKey()` already owns that judgement. Reporting it here as anything but
      // NOT_CHECKED would give two modules two opinions about one key.
      return { ...base, status: 'NOT_CHECKED', detail: `HTTP ${res.status}` };
    }
    const body = await res.json();
    const models = parseModelIds(body);
    const pricing = parseModelPricing(body);
    if (models.length === 0) {
      // 200 with nothing parseable. Claiming MEASURED here would report "this key can reach zero
      // models", which reads as an entitlement problem and would send an operator to rotate a
      // perfectly good key. An unrecognised body is our gap, not theirs.
      return { ...base, status: 'NOT_CHECKED', detail: 'HTTP 200 but no model ids parsed' };
    }
    const priced = Object.keys(pricing).length;
    return {
      ...base,
      status: 'MEASURED',
      models,
      ...(priced > 0 ? { pricing } : {}),
      detail: `HTTP 200, ${models.length} models${priced > 0 ? `, ${priced} priced` : ''}`,
    };
  } catch (e) {
    return {
      ...base,
      status: 'NOT_CHECKED',
      detail: (e as Error)?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : 'network error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh every configured provider's catalog in parallel and update the cache.
 *
 * MERGES rather than replaces: a provider that fails this round keeps its previous MEASURED entry
 * (its `fetched_at` shows the age) instead of being downgraded to NOT_CHECKED. A transient network
 * blip must not cost the quorum a model it was correctly using a minute ago — that would make this
 * module a new source of the outages it exists to absorb.
 */
export async function refreshModelCatalog(
  providers: ProviderProbe[] = PROVIDER_PROBES,
  timeoutMs = 12_000,
): Promise<ModelCatalog> {
  const results = await Promise.allSettled(providers.map((p) => fetchProviderCatalog(p, timeoutMs)));
  const entries: Record<string, ProviderCatalog> = { ...cache.entries };
  for (const r of results) {
    if (r.status !== 'fulfilled') continue; // fetchProviderCatalog never rejects; belt and braces
    const prev = entries[r.value.provider];
    if (r.value.status === 'NOT_CHECKED' && prev?.status === 'MEASURED') continue; // keep the last good list
    entries[r.value.provider] = r.value;
  }
  cache = { entries, refreshed_at: new Date().toISOString() };
  return cache;
}

/** How often the catalog refreshes. Model retirements are scheduled events, not emergencies. */
export const CATALOG_REFRESH_MS = Number(process.env.HAL_MODEL_CATALOG_REFRESH_MS) || 30 * 60 * 1000;

/**
 * THIS MODULE DELIBERATELY OWNS NO TIMER.
 *
 * An earlier version exported a `startModelCatalogRefresh()` that created its own `setInterval`,
 * and `tests/emergency-halt.test.ts` rejected it: every tick loop in this service must park on the
 * emergency halt, and a loop hidden inside a library cannot be gated by the caller. The rule is
 * right, and it binds here more than most — this loop makes outbound requests to every model vendor
 * we hold a key for. So the schedule lives in `src/index.ts`, next to its halt gate, and this module
 * exports only the work. Do not reintroduce a timer here.
 */

/** Model ids this provider's key can reach right now, or [] when the catalog has not measured it. */
export function catalogModelsFor(provider: string): string[] {
  const e = cache.entries[provider.toLowerCase()];
  return e?.status === 'MEASURED' ? e.models : [];
}

/** True only when the vendor has been ASKED and answered. Absence of evidence is not evidence. */
export function catalogIsMeasured(provider: string): boolean {
  return cache.entries[provider.toLowerCase()]?.status === 'MEASURED';
}

/** Present in this provider's measured catalog. Meaningless (and false) when nothing was measured. */
export function catalogHasModel(provider: string, model: string): boolean {
  return catalogModelsFor(provider).includes(model);
}

/** The probe row backing a provider, so callers need no second copy of the endpoint table. */
/**
 * The vendor-published rate for one model, or null if nobody published one.
 *
 * NULL IS THE POINT. A caller must be able to tell "the vendor says this costs nothing" from
 * "nobody knows what this costs", and a number cannot carry that difference. Returning 0 for the
 * unknown case would recreate the exact bug this closes.
 *
 * Synchronous, against the warm cache, because the billing path is synchronous. Before the first
 * refresh the cache is empty and every lookup is null — the static table still answers, and an
 * unpriced model stays unpriced, which is the behaviour that already exists.
 */
export function catalogPriceFor(
  provider: string,
  model: string,
): { in: number; out: number } | null {
  return cache.entries[provider.toLowerCase()]?.pricing?.[model] ?? null;
}

export { probeFor };
