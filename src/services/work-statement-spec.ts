/**
 * Canonical work-statement SPEC — the document a claim is bound to.
 *
 * work_statement_hash is SHA-256 over this JSON, computed in Postgres by
 * trg_service_contracts_work_statement. This module is the TypeScript twin:
 * it validates, normalises, and hashes the same bytes so the API can refuse
 * a bad spec with a 400 instead of a trigger exception. The trigger is the
 * fence; this is the door.
 *
 * SHAPE (keys sorted, no whitespace — this is the hashed object):
 *
 *   {
 *     "acceptance_criteria":[{"n":1,"text":"..."},{"n":2,"text":"..."}],
 *     "agreed_price":{"amount_usdc_raw":100000,"currency":"USDC"},
 *     "deadline":"2026-09-11T00:00:00.000Z",
 *     "deliverable":"..."
 *   }
 *
 * A provider cannot supply the hash: the trigger overwrites/rejects any
 * client-supplied work_statement_hash. Once bound, the statement is
 * immutable. NULL hash on a row created before this bind is LEGACY —
 * grandfathered for statuses already past fulfilled; new fulfils require
 * a hash.
 */
import { createHash } from 'node:crypto';
import { isVacuousCriteria } from './goal-ancestry';
import { canonicalJson } from './work-statement';

export const WORK_STATEMENT_SPEC_VERSION = 'hyperdag/work-statement-spec/v1';

/** Floor copied from the nightly "criteria missing or too short" gate. */
export const MIN_CRITERION_TEXT_CHARS = 24;
export const MIN_DELIVERABLE_CHARS = 8;

export const WORK_STATEMENT_ERRORS = {
  HASH_NOT_CLIENT_SET:
    'WORK_STATEMENT_HASH_NOT_CLIENT_SET: work_statement_hash is computed server-side from work_statement; a client-supplied hash is rejected',
  REQUIRED:
    'WORK_STATEMENT_REQUIRED: cannot move to fulfilled with a NULL work_statement_hash (legacy rows already past fulfilled are grandfathered)',
  IMMUTABLE:
    'WORK_STATEMENT_IMMUTABLE: work_statement cannot be altered after it is bound',
  CRITERION_NOT_IN_STATEMENT: (n: number) =>
    `CRITERION_NOT_IN_STATEMENT: criterion n=${n} is not in the hashed work statement`,
  CRITERION_RATING_INCOMPLETE:
    'CRITERION_RATING_INCOMPLETE: every numbered acceptance criterion must be rated before satisfy/settle',
  RATING_REQUIRED:
    'RATING_REQUIRED: cannot satisfy/settle without a rating',
} as const;

export interface AcceptanceCriterion {
  n: number;
  text: string;
}

export interface AgreedPrice {
  amount_usdc_raw: number;
  currency: 'USDC';
}

export interface CanonicalWorkStatement {
  acceptance_criteria: AcceptanceCriterion[];
  agreed_price: AgreedPrice;
  deadline: string;
  deliverable: string;
}

export interface CriterionRating {
  n: number;
  met: boolean;
}

export type SpecParse =
  | { ok: true; canonical: CanonicalWorkStatement; hash: string }
  | { ok: false; error: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function trimStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function isoDeadline(v: unknown): string | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseCriteria(raw: unknown): AcceptanceCriterion[] | null {
  if (!Array.isArray(raw) || raw.length < 1) return null;
  const out: AcceptanceCriterion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === 'string') {
      const text = item.trim();
      out.push({ n: i + 1, text });
      continue;
    }
    if (!isRecord(item)) return null;
    const n = asInt(item.n) ?? asInt(item.id) ?? i + 1;
    const text = trimStr(item.text) ?? trimStr(item.criterion) ?? trimStr(item.description);
    if (text == null) return null;
    out.push({ n, text });
  }
  out.sort((a, b) => a.n - b.n);
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.n !== i + 1) return null;
    if (out[i]!.text.length < MIN_CRITERION_TEXT_CHARS) return null;
    if (isVacuousCriteria(out[i]!.text)) return null;
  }
  return out;
}

/**
 * Accept the canonical object, or a loose payload/RFQ-scope shape
 * (`deliverable`/`title`/`content` + `criteria` string array).
 */
export function parseWorkStatement(
  raw: unknown,
  fallbacks?: { priceUsdcRaw?: number; deadline?: string | Date | null },
): SpecParse {
  if (!isRecord(raw) && !isRecord((raw as { work_statement?: unknown } | null)?.work_statement as object)) {
    return { ok: false, error: 'WORK_STATEMENT_INVALID', message: 'work_statement must be a JSON object' };
  }
  const src = isRecord(raw) && isRecord(raw.work_statement) ? raw.work_statement : (raw as Record<string, unknown>);

  const deliverable =
    trimStr(src.deliverable) ??
    trimStr(src.title) ??
    trimStr(src.description) ??
    trimStr(src.content) ??
    trimStr(src.task);
  if (!deliverable || deliverable.length < MIN_DELIVERABLE_CHARS) {
    return {
      ok: false,
      error: 'WORK_STATEMENT_INVALID',
      message: `deliverable must be a string of at least ${MIN_DELIVERABLE_CHARS} characters`,
    };
  }

  const criteria = parseCriteria(
    src.acceptance_criteria ?? src.criteria ?? src.acceptanceCriteria,
  );
  if (!criteria) {
    return {
      ok: false,
      error: 'WORK_STATEMENT_INVALID',
      message:
        'acceptance_criteria must be a non-empty numbered list; each text must be explicit ' +
        `(≥${MIN_CRITERION_TEXT_CHARS} chars, not a placeholder)`,
    };
  }

  const priceRaw =
    asInt(isRecord(src.agreed_price) ? src.agreed_price.amount_usdc_raw : undefined) ??
    asInt(src.agreed_price_usdc_raw) ??
    asInt(src.price_usdc_raw) ??
    asInt(fallbacks?.priceUsdcRaw);
  const currencyRaw =
    (isRecord(src.agreed_price) ? trimStr(src.agreed_price.currency) : null) ?? 'USDC';
  if (priceRaw == null || priceRaw <= 0) {
    return {
      ok: false,
      error: 'WORK_STATEMENT_INVALID',
      message: 'agreed_price.amount_usdc_raw must be a positive integer (raw USDC units)',
    };
  }
  if (currencyRaw !== 'USDC') {
    return {
      ok: false,
      error: 'WORK_STATEMENT_INVALID',
      message: 'agreed_price.currency must be USDC',
    };
  }

  const deadline = isoDeadline(src.deadline) ?? isoDeadline(src.deadline_at) ?? isoDeadline(fallbacks?.deadline);
  if (!deadline) {
    return {
      ok: false,
      error: 'WORK_STATEMENT_INVALID',
      message: 'deadline must be a valid ISO-8601 timestamp',
    };
  }

  const canonical: CanonicalWorkStatement = {
    acceptance_criteria: criteria.map((c) => ({ n: c.n, text: c.text })),
    agreed_price: { amount_usdc_raw: priceRaw, currency: 'USDC' },
    deadline,
    deliverable,
  };
  return { ok: true, canonical, hash: specWorkStatementHash(canonical) };
}

export function specCanonicalJson(canonical: CanonicalWorkStatement): string {
  return canonicalJson(canonical);
}

export function specWorkStatementHash(canonical: CanonicalWorkStatement): string {
  return '0x' + createHash('sha256').update(specCanonicalJson(canonical), 'utf8').digest('hex');
}

export type RatingParse =
  | { ok: true; ratings: CriterionRating[]; score: number }
  | { ok: false; error: string; message: string };

export function parseCriterionRatings(
  raw: unknown,
  statement: CanonicalWorkStatement,
): RatingParse {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.ratings)
      ? raw.ratings
      : null;
  if (!list) {
    return { ok: false, error: 'RATING_REQUIRED', message: WORK_STATEMENT_ERRORS.RATING_REQUIRED };
  }

  const byN = new Map<number, boolean>();
  for (const item of list) {
    if (!isRecord(item)) {
      return { ok: false, error: 'RATING_REQUIRED', message: 'each rating must be {n, met}' };
    }
    const n = asInt(item.n);
    if (n == null) {
      return { ok: false, error: 'RATING_REQUIRED', message: 'each rating must be {n, met}' };
    }
    if (!statement.acceptance_criteria.some((c) => c.n === n)) {
      return {
        ok: false,
        error: 'CRITERION_NOT_IN_STATEMENT',
        message: WORK_STATEMENT_ERRORS.CRITERION_NOT_IN_STATEMENT(n),
      };
    }
    if (typeof item.met !== 'boolean') {
      return { ok: false, error: 'RATING_REQUIRED', message: `criterion n=${n} met must be boolean` };
    }
    byN.set(n, item.met);
  }

  for (const c of statement.acceptance_criteria) {
    if (!byN.has(c.n)) {
      return {
        ok: false,
        error: 'CRITERION_RATING_INCOMPLETE',
        message: WORK_STATEMENT_ERRORS.CRITERION_RATING_INCOMPLETE,
      };
    }
  }

  const ratings = statement.acceptance_criteria.map((c) => ({ n: c.n, met: byN.get(c.n)! }));
  const metCount = ratings.filter((r) => r.met).length;
  const score = Number((metCount / ratings.length).toFixed(4));
  return { ok: true, ratings, score };
}

export function deriveSatisfactionScore(ratings: CriterionRating[]): number {
  if (ratings.length === 0) return 0;
  const metCount = ratings.filter((r) => r.met).length;
  return Number((metCount / ratings.length).toFixed(4));
}
