/**
 * S-SPINE Phase 3 — TrustChat leaderboard backend (public, read-mostly).
 *
 * Aggregates `trustchat_sessions` (real, non-example rows) by LLM provider into a trust
 * leaderboard, plus per-provider detail, a comparison-vote sink, and a session rating PATCH.
 *
 * hal_score is a RISK score in [0,1] (HIGH = likely hallucination). The leaderboard ranks by
 * LOWEST avg risk = most trusted. Aggregation is done in-process (dataset is small) behind a
 * 5-minute cache so this public surface doesn't hit the DB per request.
 *
 * Mounted BEFORE authMiddleware (public). Rating/vote writes use the service-role db client.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { verifyChainBreaks } from '../services/audit/verify-chain-db';

const router = Router();

const SIGNAL_KEYS = [
  'harm_probability', 'epistemic_uncertainty', 'evidence_quality',
  'scope_appropriateness', 'certainty_at_claim',
] as const;

// Display metadata for known providers. Unknown providers get a derived display name.
const PROVIDER_META: Record<string, { display_name: string; company: string }> = {
  'anthropic': { display_name: 'Claude (Anthropic)', company: 'Anthropic' },
  'anthropic-direct': { display_name: 'Claude (Anthropic)', company: 'Anthropic' },
  'claude': { display_name: 'Claude (Anthropic)', company: 'Anthropic' },
  'openai': { display_name: 'GPT-4o (OpenAI)', company: 'OpenAI' },
  'groq': { display_name: 'Llama 3.x (Groq)', company: 'Groq' },
  'groq-llama': { display_name: 'Llama 3.x (Groq)', company: 'Groq' },
  'cerebras': { display_name: 'Llama (Cerebras)', company: 'Cerebras' },
  'fireworks': { display_name: 'Fireworks', company: 'Fireworks AI' },
  'gemini': { display_name: 'Gemini (Google)', company: 'Google' },
  'google': { display_name: 'Gemini (Google)', company: 'Google' },
  'deepseek': { display_name: 'DeepSeek', company: 'DeepSeek' },
  'cohere': { display_name: 'Command (Cohere)', company: 'Cohere' },
};

const meta = (p: string) =>
  PROVIDER_META[p?.toLowerCase()] ?? { display_name: p ?? 'unknown', company: '—' };

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface SessionRow {
  llm_provider_used: string | null;
  llm_model: string | null;
  hal_score: number | null;
  hal_signals: Record<string, any> | null;
  hal_verdict: string | null;
  hal_flagged_hallucination: boolean | null;
  created_at: string;
}

async function fetchRealSessions(limit = 5000): Promise<SessionRow[]> {
  const { data, error } = await db
    .from('trustchat_sessions')
    .select('llm_provider_used, llm_model, hal_score, hal_signals, hal_verdict, hal_flagged_hallucination, created_at')
    .not('example_data', 'is', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as SessionRow[];
}

export function aggregate(rows: SessionRow[]) {
  const byProvider = new Map<string, SessionRow[]>();
  for (const r of rows) {
    const p = r.llm_provider_used ?? 'unknown';
    (byProvider.get(p) ?? byProvider.set(p, []).get(p)!).push(r);
  }
  const providers = [...byProvider.entries()].map(([name, rs]) => {
    const scores = rs.map(r => Number(r.hal_score)).filter(Number.isFinite);
    const avg_signals: Record<string, number> = {};
    for (const k of SIGNAL_KEYS) {
      const vals = rs.map(r => Number(r.hal_signals?.[k])).filter(Number.isFinite);
      avg_signals[k] = r2(avg(vals));
    }
    const hallucinations = rs.filter(r => r.hal_flagged_hallucination === true).length;
    const vetoes = rs.filter(r => (r.hal_verdict ?? '').toUpperCase() === 'VETO').length;
    const lastModel = rs.find(r => r.llm_model)?.llm_model ?? null;
    return {
      name,
      display_name: meta(name).display_name,
      company: meta(name).company,
      model: lastModel,
      avg_score: r2(avg(scores)),                 // avg RISK (lower = more trusted)
      total_evaluations: rs.length,
      avg_signals,
      hallucination_rate: r2(rs.length ? hallucinations / rs.length : 0),
      veto_rate: r2(rs.length ? vetoes / rs.length : 0),
      verified: false,                            // on-chain attestation not yet wired for these
      last_evaluation: rs.map(r => r.created_at).sort().slice(-1)[0] ?? null,
    };
  });
  // Rank by lowest avg risk; providers with 0 scored evals sink to the bottom.
  providers.sort((a, b) =>
    (a.total_evaluations === 0 ? 1 : 0) - (b.total_evaluations === 0 ? 1 : 0) || a.avg_score - b.avg_score);
  return providers;
}

// 5-minute cache for the heavy aggregate.
let cache: { at: number; payload: any } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function integrityStatus(): Promise<string> {
  const r = await verifyChainBreaks('hal_classifications');
  if (!r) return 'UNVERIFIED'; // DB pooler unavailable in this environment
  return r.status; // VALID | CHAIN_BREAK
}

// GET /leaderboard — provider trust ranking.
router.get('/leaderboard', async (_req: Request, res: Response) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.payload);
    const rows = await fetchRealSessions();
    const providers = aggregate(rows);
    const integrity = await integrityStatus();
    const payload = {
      providers,
      total_evaluations: rows.length,
      last_updated: new Date().toISOString(),
      integrity,
    };
    cache = { at: Date.now(), payload };
    return res.json(payload);
  } catch (e: any) {
    return res.status(500).json({ error: 'leaderboard_failed', detail: e?.message ?? String(e) });
  }
});

// GET /leaderboard/:provider — per-provider detail + recent evaluations.
router.get('/leaderboard/:provider', async (req: Request, res: Response) => {
  const provider = String(req.params.provider);
  try {
    const rows = await fetchRealSessions();
    const mine = rows.filter(r => (r.llm_provider_used ?? '').toLowerCase() === provider.toLowerCase());
    if (mine.length === 0) {
      return res.status(404).json({ error: 'provider_not_found', provider });
    }
    const agg = aggregate(mine)[0];
    // recent 10 (truncated responses), newest first
    const recent = mine.slice(0, 10).map(r => ({
      hal_score: r.hal_score,
      hal_verdict: r.hal_verdict,
      flagged_hallucination: r.hal_flagged_hallucination,
      model: r.llm_model,
      created_at: r.created_at,
    }));
    // 7-day rolling avg (by day)
    const byDay = new Map<string, number[]>();
    for (const r of mine) {
      const day = r.created_at.slice(0, 10);
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(Number(r.hal_score));
    }
    const trend = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-7)
      .map(([day, scores]) => ({ day, avg_score: r2(avg(scores.filter(Number.isFinite))), n: scores.length }));
    return res.json({ ...agg, recent, trend });
  } catch (e: any) {
    return res.status(500).json({ error: 'provider_detail_failed', detail: e?.message ?? String(e) });
  }
});

// POST /comparison/vote — store a head-to-head preference into comparison_votes.
router.post('/comparison/vote', async (req: Request, res: Response) => {
  const { session_id_left, session_id_right, winner, prompt } = req.body ?? {};
  if (!session_id_left || !session_id_right || !['left', 'right', 'tie'].includes(winner)) {
    return res.status(400).json({ error: 'invalid_vote', expected: 'session_id_left, session_id_right, winner in {left,right,tie}' });
  }
  try {
    const { data, error } = await db
      .from('comparison_votes')
      .insert({ session_id_left, session_id_right, winner, prompt: prompt ?? null })
      .select('id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'vote_insert_failed', detail: error.message });
    return res.status(201).json({ ok: true, id: (data as any)?.id ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: 'vote_failed', detail: e?.message ?? String(e) });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /session/:sessionId — public single-evaluation read for the share page.
// Returns the shareable evaluation (prompt, provider, response, HAL verdict + signals,
// rating, view_count). Public read — a user sharing their own evaluation result.
router.get('/session/:sessionId', async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ error: 'invalid_session_id' });
  try {
    const { data, error } = await db
      .from('trustchat_sessions')
      .select('session_id, user_message, llm_provider_used, llm_model, llm_response, hal_score, hal_verdict, hal_signals, hal_flagged_hallucination, rating, rating_feedback, view_count, created_at')
      .eq('session_id', sessionId)
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'session_fetch_failed', detail: error.message });
    if (!data) return res.status(404).json({ error: 'session_not_found', session_id: sessionId });
    const row: any = data;
    return res.json({
      ...row,
      provider_display: meta(row.llm_provider_used ?? '').display_name,
      company: meta(row.llm_provider_used ?? '').company,
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'session_failed', detail: e?.message ?? String(e) });
  }
});

// POST /session/:sessionId/view — increment the share-page view counter. Public, idempotent-ish
// (best-effort analytics; not rate-limited beyond the global limiter). Returns the new count.
router.post('/session/:sessionId/view', async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  if (!UUID_RE.test(sessionId)) return res.status(400).json({ error: 'invalid_session_id' });
  try {
    // Atomic increment via RPC-free read-modify-write is racy; use a single SQL UPDATE through
    // the service client. supabase-js lacks expression updates, so fetch-then-update with the
    // current value (best-effort; a lost update on a concurrent view is acceptable for a counter).
    const { data: cur } = await db
      .from('trustchat_sessions').select('view_count').eq('session_id', sessionId).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'session_not_found', session_id: sessionId });
    const next = (Number((cur as any).view_count) || 0) + 1;
    const { error } = await db
      .from('trustchat_sessions').update({ view_count: next }).eq('session_id', sessionId);
    if (error) return res.status(500).json({ error: 'view_increment_failed', detail: error.message });
    return res.json({ ok: true, view_count: next });
  } catch (e: any) {
    return res.status(500).json({ error: 'view_failed', detail: e?.message ?? String(e) });
  }
});

// PATCH /session/:sessionId/rate — update an existing session's rating.
router.patch('/session/:sessionId/rate', async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  const { rating, rating_feedback, hal_agreement } = req.body ?? {};
  if (rating !== undefined && (typeof rating !== 'number' || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'invalid_rating', expected: 'rating is an integer 1..5' });
  }
  try {
    const update: Record<string, any> = { rated_at: new Date().toISOString() };
    if (rating !== undefined) update.rating = Math.round(rating);
    if (rating_feedback !== undefined) update.rating_feedback = String(rating_feedback);
    if (hal_agreement !== undefined) {
      // stash hal_agreement in rating_feedback if no dedicated column — keep it simple + non-destructive
      update.rating_feedback = update.rating_feedback ?? `hal_agreement:${hal_agreement}`;
    }
    const { data, error } = await db
      .from('trustchat_sessions')
      .update(update)
      .eq('session_id', sessionId)
      .select('session_id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'rate_update_failed', detail: error.message });
    if (!data) return res.status(404).json({ error: 'session_not_found', session_id: sessionId });
    return res.json({ ok: true, session_id: sessionId });
  } catch (e: any) {
    return res.status(500).json({ error: 'rate_failed', detail: e?.message ?? String(e) });
  }
});

// Test hook — clear the leaderboard cache.
export function __clearLeaderboardCache() { cache = null; }

export default router;
