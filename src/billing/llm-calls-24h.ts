/**
 * Paginated 24h reader for `llm_call_log`. PostgREST caps a single response at 1000 rows, so the
 * cost/efficiency dashboards page through `.range()` to aggregate the full window accurately
 * (~7k rows/day → ~7 pages). Capped at `maxRows` as a safety bound; the caller flags if hit.
 */
import { db } from '../db';

const PAGE = 1000;

export async function fetchLlmCalls24h<T = any>(select: string, maxRows = 60000): Promise<{ rows: T[]; capped: boolean }> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await db
      .from('llm_call_log')
      .select(select)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, capped: false };
  }
  return { rows, capped: true };
}
