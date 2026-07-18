/**
 * HAL retrieval — web-search-backed evidence retrieval for a claim (WS1.2a SLOW PATH).
 *
 * WHY THIS EXISTS (ANTIFRAGILE_PROVENANCE_PROGRAM_v0 §ARCHITECTURE — SETTLED, 2026-07-18):
 * HAL's fast parametric quorum (src/hal/fact-check.ts) votes from model *weights*; its residual
 * errors are all "the panel doesn't know the fact." The WS1.1 spike proved that giving the panel
 * *retrieved evidence* corrects 75-94% of those obscure-fact errors. This module is the retrieval
 * half of the confidence-triggered SLOW PATH: it fetches candidate evidence for a claim from the
 * live web, each snippet carrying explicit provenance {url, domain, timestamp, content_hash} so the
 * CRAG grader (src/hal/crag.ts) can apply its non-gameable, corroboration-based defenses.
 *
 * DESIGN CONSTRAINTS (match fact-check.ts style):
 *  - RESILIENT (RULE-8): NEVER throws. Any failure (missing key, network, non-200, bad JSON, timeout)
 *    degrades to an EMPTY evidence array — the caller then keeps the fast-path decision unchanged.
 *  - SHADOW-SAFE: this module is only ever invoked from the HAL_RETRIEVAL_ENABLED-gated block in
 *    fact-check.ts, so importing it changes nothing until the flag is on.
 *  - Reuses the established Firecrawl integration shape (src/engine/mcp.ts executeFirecrawl): the
 *    `/v2/search` endpoint at FIRECRAWL_API_BASE with a Bearer FIRECRAWL_API_KEY. Falls back to
 *    Tavily (TAVILY_API_KEY) and Brave (BRAVE_SEARCH_API_KEY) when Firecrawl is absent, so the slow
 *    path can still form evidence from whichever web-search key is provisioned in .env.master.
 *  - Keys are read from process.env (loaded from ../.env.master at boot) and NEVER printed.
 */
import crypto from 'crypto';

/** Provenance travels with every snippet — the CRAG grader enforces it (drops sources missing it). */
export interface EvidenceProvenance {
  url: string;
  domain: string; // full hostname, e.g. "en.wikipedia.org"
  timestamp: string; // ISO8601 — publish/last-modified when the source reports it, else retrieval time
  content_hash: string; // sha256(content) — tamper-evidence + dedup key
}

export interface EvidenceSnippet {
  content: string; // the retrieved text (title + snippet/markdown, truncated)
  provenance: EvidenceProvenance;
  source: 'firecrawl' | 'tavily' | 'brave'; // which retriever produced it (telemetry)
  rank: number; // 0-based rank in the retriever's result list (freshness/relevance proxy)
}

export interface RetrievalOpts {
  maxSources?: number; // default HAL_RETRIEVAL_MAX_SOURCES or 5
  timeoutMs?: number; // default HAL_RETRIEVAL_TIMEOUT_MS or 8000
  maxContentChars?: number; // per-snippet cap, default 1200
}

const FIRECRAWL_API_BASE = process.env.FIRECRAWL_API_BASE || 'https://api.firecrawl.dev';

/** Full hostname from a URL (lowercased); '' when unparseable (that source is later dropped). */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * sha256 hex of the snippet content — tamper-evidence + a stable dedup key so two retrievers returning
 * the same page collapse. String-coerced so a non-string never throws in this never-throw module.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(String(content ?? '')).digest('hex');
}

/** Bounded fetch that resolves to null on ANY failure (never throws) — the module-wide contract. */
async function safeFetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Normalize a raw {url,title,text,timestamp} hit into an EvidenceSnippet; null when url is unusable. */
function toSnippet(
  raw: { url?: unknown; title?: unknown; text?: unknown; timestamp?: unknown },
  source: EvidenceSnippet['source'],
  rank: number,
  maxContentChars: number,
): EvidenceSnippet | null {
  const url = typeof raw.url === 'string' ? raw.url : '';
  const domain = hostnameOf(url);
  if (!domain) return null; // no usable URL → CRAG would drop it anyway; skip early
  const title = typeof raw.title === 'string' ? raw.title : '';
  const text = typeof raw.text === 'string' ? raw.text : '';
  const content = `${title}\n${text}`.trim().slice(0, maxContentChars);
  if (!content) return null;
  // Prefer a source-reported timestamp (freshness signal); fall back to retrieval time.
  const ts =
    typeof raw.timestamp === 'string' && !Number.isNaN(Date.parse(raw.timestamp))
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString();
  return {
    content,
    source,
    rank,
    provenance: { url, domain, timestamp: ts, content_hash: contentHash(content) },
  };
}

/** Firecrawl /v2/search — same endpoint/shape as src/engine/mcp.ts executeFirecrawl. */
async function searchFirecrawl(
  claim: string,
  limit: number,
  timeoutMs: number,
  maxContentChars: number,
): Promise<EvidenceSnippet[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) return [];
  const json = await safeFetchJson(
    `${FIRECRAWL_API_BASE}/v2/search`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: claim, limit }),
    },
    timeoutMs,
  );
  if (!json) return [];
  // Firecrawl returns { data: { web: [...] } } or { data: [...] } across versions — handle both.
  const rows: any[] = Array.isArray(json?.data)
    ? json.data
    : Array.isArray(json?.data?.web)
      ? json.data.web
      : Array.isArray(json?.web)
        ? json.web
        : [];
  const out: EvidenceSnippet[] = [];
  rows.forEach((r, i) => {
    const s = toSnippet(
      { url: r?.url, title: r?.title, text: r?.description ?? r?.markdown ?? r?.snippet, timestamp: r?.publishedDate ?? r?.date },
      'firecrawl',
      i,
      maxContentChars,
    );
    if (s) out.push(s);
  });
  return out;
}

/** Tavily search — fallback retriever (TAVILY_API_KEY). */
async function searchTavily(
  claim: string,
  limit: number,
  timeoutMs: number,
  maxContentChars: number,
): Promise<EvidenceSnippet[]> {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) return [];
  const json = await safeFetchJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: claim, max_results: limit, search_depth: 'basic' }),
    },
    timeoutMs,
  );
  if (!json) return [];
  const rows: any[] = Array.isArray(json?.results) ? json.results : [];
  const out: EvidenceSnippet[] = [];
  rows.forEach((r, i) => {
    const s = toSnippet(
      { url: r?.url, title: r?.title, text: r?.content, timestamp: r?.published_date },
      'tavily',
      i,
      maxContentChars,
    );
    if (s) out.push(s);
  });
  return out;
}

/** Brave web search — last-resort retriever (BRAVE_SEARCH_API_KEY, GET + header key). */
async function searchBrave(
  claim: string,
  limit: number,
  timeoutMs: number,
  maxContentChars: number,
): Promise<EvidenceSnippet[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) return [];
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', claim);
  u.searchParams.set('count', String(limit));
  const json = await safeFetchJson(
    u.toString(),
    { method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey } },
    timeoutMs,
  );
  if (!json) return [];
  const rows: any[] = Array.isArray(json?.web?.results) ? json.web.results : [];
  const out: EvidenceSnippet[] = [];
  rows.forEach((r, i) => {
    const s = toSnippet(
      { url: r?.url, title: r?.title, text: r?.description, timestamp: r?.age ?? r?.page_age },
      'brave',
      i,
      maxContentChars,
    );
    if (s) out.push(s);
  });
  return out;
}

/**
 * Retrieve candidate evidence for a claim from the live web. Tries the provisioned retrievers in
 * cost/quality order (Firecrawl → Tavily → Brave) and returns the FIRST that yields snippets; if none
 * do, returns []. NEVER throws — a failed retrieval degrades to empty evidence and the caller keeps
 * the fast-path decision. Snippets are de-duplicated by content_hash.
 */
export async function retrieveEvidence(claim: string, opts: RetrievalOpts = {}): Promise<EvidenceSnippet[]> {
  try {
    const maxSources = clampInt(opts.maxSources ?? process.env.HAL_RETRIEVAL_MAX_SOURCES, 5, 1, 10);
    const timeoutMs = clampInt(opts.timeoutMs ?? process.env.HAL_RETRIEVAL_TIMEOUT_MS, 8000, 1000, 30000);
    const maxContentChars = clampInt(opts.maxContentChars, 1200, 200, 8000);
    const query = String(claim ?? '').slice(0, 500).trim();
    if (!query) return [];

    // Cost/quality-ordered: use the first retriever that actually returns evidence.
    const retrievers = [searchFirecrawl, searchTavily, searchBrave];
    let snippets: EvidenceSnippet[] = [];
    for (const r of retrievers) {
      snippets = await r(query, maxSources, timeoutMs, maxContentChars);
      if (snippets.length > 0) break;
    }

    // De-dup by content_hash (two retrievers / two ranks returning the same page collapse to one).
    const seen = new Set<string>();
    const deduped: EvidenceSnippet[] = [];
    for (const s of snippets) {
      if (seen.has(s.provenance.content_hash)) continue;
      seen.add(s.provenance.content_hash);
      deduped.push(s);
    }
    return deduped.slice(0, maxSources);
  } catch (e) {
    // Absolute never-throw guard — any unexpected error degrades to empty evidence.
    console.warn(`[hal/retrieval] degraded (ignored): ${(e as Error)?.message ?? String(e)}`);
    return [];
  }
}

/** Parse+clamp an int from an env string or number; NaN/out-of-range → default. */
function clampInt(v: string | number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}
