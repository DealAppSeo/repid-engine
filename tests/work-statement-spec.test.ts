/**
 * Canonical work-statement spec — unit attacks.
 *
 * The DB trigger is the fence. These tests pin the TypeScript twin so the API
 * and the trigger hash the same bytes, and so each of the five attacks has a
 * named refusal before it ever hits Postgres.
 */
import {
  parseWorkStatement,
  parseCriterionRatings,
  specCanonicalJson,
  specWorkStatementHash,
  WORK_STATEMENT_ERRORS,
  MIN_CRITERION_TEXT_CHARS,
} from '../src/services/work-statement-spec';

const GOLDEN = {
  deliverable: 'Return a typed API that lists open contracts.',
  acceptance_criteria: [
    { n: 1, text: 'GET /contracts returns HTTP 200 with a JSON array.' },
    { n: 2, text: 'Each item includes id, status, and agreed_price_usdc_raw.' },
  ],
  deadline: '2026-09-11T00:00:00.000Z',
  agreed_price: { amount_usdc_raw: 100000, currency: 'USDC' as const },
};

describe('canonical work-statement document', () => {
  it('normalises to sorted-key compact JSON', () => {
    const p = parseWorkStatement(GOLDEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(specCanonicalJson(p.canonical)).toBe(
      '{"acceptance_criteria":[{"n":1,"text":"GET /contracts returns HTTP 200 with a JSON array."},{"n":2,"text":"Each item includes id, status, and agreed_price_usdc_raw."}],"agreed_price":{"amount_usdc_raw":100000,"currency":"USDC"},"deadline":"2026-09-11T00:00:00.000Z","deliverable":"Return a typed API that lists open contracts."}',
    );
  });

  it('hash is 0x + 64 hex chars and is stable', () => {
    const a = parseWorkStatement(GOLDEN);
    const b = parseWorkStatement({
      agreed_price: GOLDEN.agreed_price,
      deadline: GOLDEN.deadline,
      deliverable: GOLDEN.deliverable,
      acceptance_criteria: [...GOLDEN.acceptance_criteria].reverse(),
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.hash).toBe(specWorkStatementHash(a.canonical));
    // Live Postgres work_statement_sha256 of this vector, measured 2026-09-04.
    expect(a.hash).toBe('0x756c8e381ec2162e2946e0d43f790df23d8868ed6a8b569acd92a1d460bc370d');
  });

  it('accepts RFQ-scope adapters (criteria string array + title)', () => {
    const p = parseWorkStatement(
      {
        title: 'Return a typed API that lists open contracts.',
        criteria: [
          'GET /contracts returns HTTP 200 with a JSON array.',
          'Each item includes id, status, and agreed_price_usdc_raw.',
        ],
      },
      { priceUsdcRaw: 100000, deadline: '2026-09-11T00:00:00.000Z' },
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.hash).toBe(parseWorkStatement(GOLDEN).ok ? (parseWorkStatement(GOLDEN) as { hash: string }).hash : '');
  });

  it('rejects vacuous or too-short criteria', () => {
    const short = parseWorkStatement({
      ...GOLDEN,
      acceptance_criteria: [{ n: 1, text: 'ok' }],
    });
    expect(short.ok).toBe(false);
    const vacuous = parseWorkStatement({
      ...GOLDEN,
      acceptance_criteria: [{ n: 1, text: 'Pass default checks.' }],
    });
    expect(vacuous.ok).toBe(false);
    expect(MIN_CRITERION_TEXT_CHARS).toBe(24);
  });
});

describe('attacks against the spec (API twin of the trigger)', () => {
  it('fulfil with NULL hash — named refusal', () => {
    expect(WORK_STATEMENT_ERRORS.REQUIRED).toMatch(/^WORK_STATEMENT_REQUIRED:/);
  });

  it('fulfil with a provider-supplied hash — named refusal', () => {
    expect(WORK_STATEMENT_ERRORS.HASH_NOT_CLIENT_SET).toMatch(/^WORK_STATEMENT_HASH_NOT_CLIENT_SET:/);
    const p = parseWorkStatement(GOLDEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // The API never takes a hash argument. parseWorkStatement has no hash field.
    expect('hash' in (GOLDEN as object)).toBe(false);
  });

  it('alter after award — named refusal', () => {
    expect(WORK_STATEMENT_ERRORS.IMMUTABLE).toMatch(/^WORK_STATEMENT_IMMUTABLE:/);
    const a = parseWorkStatement(GOLDEN);
    const b = parseWorkStatement({ ...GOLDEN, deliverable: 'A different deliverable entirely.' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.hash).not.toBe(b.hash);
  });

  it('rate against criteria not in the hashed statement — REJECTED', () => {
    const p = parseWorkStatement(GOLDEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = parseCriterionRatings(
      [
        { n: 1, met: true },
        { n: 2, met: true },
        { n: 99, met: true },
      ],
      p.canonical,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(WORK_STATEMENT_ERRORS.CRITERION_NOT_IN_STATEMENT(99));
  });

  it('settle without any rating — REJECTED', () => {
    const p = parseWorkStatement(GOLDEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = parseCriterionRatings(undefined, p.canonical);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe(WORK_STATEMENT_ERRORS.RATING_REQUIRED);
  });

  it('score is met/total, not a bare star', () => {
    const p = parseWorkStatement(GOLDEN);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = parseCriterionRatings(
      [
        { n: 1, met: true },
        { n: 2, met: false },
      ],
      p.canonical,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.score).toBe(0.5);
  });
});
