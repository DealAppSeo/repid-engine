/**
 * PARITY GATE: the JS port must reproduce PostgreSQL byte for byte.
 *
 * `service_contracts.work_statement_hash` is written only by
 * `trg_service_contracts_work_statement` → `work_statement_sha256(ws)` →
 * `'0x' || sha256(work_statement_canonical_text(ws))`. The trigger refuses a
 * client-supplied hash, so Postgres is the sole writer and the SQL is the
 * definition. This file is a transcription of that SQL, and a transcription is
 * only as good as its oracle.
 *
 * WHY THE PARITY MATTERS MORE THAN THE PORT. A port that drifts by ONE BYTE
 * disagrees with every stored row, and the failure surfaces as "this contract
 * was tampered with" — an accusation against a counterparty, produced by our own
 * bug. That is the worst possible failure mode for a verification tool, so the
 * oracle here is not a hand-written fixture: the canonical text and the hash
 * below were read out of the LIVE production database with
 *
 *   select work_statement, work_statement_hash,
 *          public.work_statement_canonical_text(work_statement)
 *     from service_contracts where work_statement_hash is not null;
 *
 * for contract 8de29497-380a-402a-ab48-5e93d3f43920 [MEASURED 2026-09-04].
 * Same discipline as zkp-vault pinning Poseidon2 against the Rust oracle.
 *
 * If the SQL function ever changes, this test fails and names the disagreement
 * rather than letting the verifier quietly start accusing people.
 */
import {
  workStatementCanonicalText,
  workStatementCanonicalHash,
  recomputeWorkStatementHash,
  recomputeSatisfactionScore,
  type WorkStatement,
} from '../src/services/work-statement-canonical';

/** Read verbatim from the live row. Do not "tidy" — the bytes are the oracle. */
const LIVE_WS: WorkStatement = {
  deadline: '2026-09-11T00:00:00.000Z',
  deliverable:
    'Research report: (1) capabilities AI agents need to materially contribute to solving a Millennium Prize Problem; (2) per-problem current status and strongest published claim for or against.',
  agreed_price: { currency: 'USDC', amount_usdc_raw: 50000 },
  acceptance_criteria: [
    { n: 1, text: 'All 7 Millennium Prize Problems named correctly.' },
    { n: 2, text: 'Solved/unsolved status stated correctly for each, identifying the one solved case with its solver and date.' },
    { n: 3, text: 'Minimum 8 citations, each with author, title, year, and a resolvable DOI or arXiv identifier; no invented citations.' },
    { n: 4, text: 'Minimum 3 verbatim direct quotes, each attributed to a citation listed under criterion 3.' },
    { n: 5, text: 'Every forecast or timeline claim is explicitly labelled an estimate with its basis, or the report states no reliable forecast is possible.' },
    { n: 6, text: 'The report explicitly states its own limitations.' },
  ],
};

/** `public.work_statement_canonical_text(work_statement)` on that row. */
const LIVE_CANONICAL_TEXT =
  '{"acceptance_criteria":[{"n":1,"text":"All 7 Millennium Prize Problems named correctly."},{"n":2,"text":"Solved/unsolved status stated correctly for each, identifying the one solved case with its solver and date."},{"n":3,"text":"Minimum 8 citations, each with author, title, year, and a resolvable DOI or arXiv identifier; no invented citations."},{"n":4,"text":"Minimum 3 verbatim direct quotes, each attributed to a citation listed under criterion 3."},{"n":5,"text":"Every forecast or timeline claim is explicitly labelled an estimate with its basis, or the report states no reliable forecast is possible."},{"n":6,"text":"The report explicitly states its own limitations."}],"agreed_price":{"amount_usdc_raw":50000,"currency":"USDC"},"deadline":"2026-09-11T00:00:00.000Z","deliverable":"Research report: (1) capabilities AI agents need to materially contribute to solving a Millennium Prize Problem; (2) per-problem current status and strongest published claim for or against."}';

/** `service_contracts.work_statement_hash` on that row. */
const LIVE_HASH = '0xb702d9b110d17be53e65a1cde232f94958285e095cd2611b31f5174f835a1c0b';

describe('parity with PostgreSQL (live production oracle)', () => {
  it('reproduces work_statement_canonical_text byte for byte', () => {
    expect(workStatementCanonicalText(LIVE_WS)).toBe(LIVE_CANONICAL_TEXT);
  });

  it('reproduces work_statement_sha256', () => {
    expect(workStatementCanonicalHash(LIVE_WS)).toBe(LIVE_HASH);
  });

  it('sorts criteria by n, so key order in the source JSON cannot change the hash', () => {
    const shuffled: WorkStatement = {
      ...LIVE_WS,
      acceptance_criteria: [...LIVE_WS.acceptance_criteria].reverse(),
    };
    expect(workStatementCanonicalHash(shuffled)).toBe(LIVE_HASH);
  });
});

describe('recompute: three outcomes, never two', () => {
  it('VERIFIED when the published spec hashes to the stored value', () => {
    const r = recomputeWorkStatementHash(LIVE_WS, LIVE_HASH);
    expect(r.outcome).toBe('VERIFIED');
  });

  it('FAILED when one character of the spec was edited after binding', () => {
    // The property the hash exists for: a spec edited post-settlement no longer
    // matches. One character in one criterion is enough.
    const tampered: WorkStatement = {
      ...LIVE_WS,
      acceptance_criteria: LIVE_WS.acceptance_criteria.map((c) =>
        c.n === 3 ? { ...c, text: c.text.replace('Minimum 8', 'Minimum 2') } : c,
      ),
    };
    const r = recomputeWorkStatementHash(tampered, LIVE_HASH);
    expect(r.outcome).toBe('FAILED');
    expect(r.expected).not.toBe(LIVE_HASH);
  });

  it('FAILED when the price was edited after binding', () => {
    const repriced: WorkStatement = { ...LIVE_WS, agreed_price: { currency: 'USDC', amount_usdc_raw: 1 } };
    expect(recomputeWorkStatementHash(repriced, LIVE_HASH).outcome).toBe('FAILED');
  });

  it('NOT_CHECKED — not a pass — when the receipt publishes no statement', () => {
    // This is the state EVERY receipt was in before the statement was published:
    // a hash with no preimage. Calling that verified is the whole failure class.
    const r = recomputeWorkStatementHash(null, LIVE_HASH);
    expect(r.outcome).toBe('NOT_CHECKED');
    expect(r.detail).toMatch(/nothing to recompute/);
  });

  it('NOT_CHECKED when the contract predates the binding', () => {
    expect(recomputeWorkStatementHash(LIVE_WS, null).outcome).toBe('NOT_CHECKED');
  });
});

describe('the satisfaction score is derived, and that is checkable', () => {
  const six = [1, 2, 3, 4, 5, 6];

  it('reproduces the live 0.0000 from six unmet criteria', () => {
    // The real row: a paper-mode run that honestly rated every criterion unmet
    // rather than fabricating a passing deliverable.
    const ratings = six.map((n) => ({ n, met: false }));
    const r = recomputeSatisfactionScore(ratings, '0.0000');
    expect(r.outcome).toBe('VERIFIED');
    expect(r.expected).toBe('0.0000');
  });

  it('matches round(met/total, 4) for a partial result', () => {
    const ratings = six.map((n) => ({ n, met: n <= 4 })); // 4 of 6
    expect(recomputeSatisfactionScore(ratings, '0.6667').outcome).toBe('VERIFIED');
  });

  it('FAILED when a score was asserted rather than derived', () => {
    // A buyer claiming 1.0 over ratings that say otherwise is exactly what the
    // trigger refuses; this is the outsider being able to see that too.
    const ratings = six.map((n) => ({ n, met: false }));
    const r = recomputeSatisfactionScore(ratings, 1);
    expect(r.outcome).toBe('FAILED');
    expect(r.detail).toMatch(/not derived from the ratings/);
  });

  it('NOT_CHECKED when ratings are absent (legacy contracts)', () => {
    expect(recomputeSatisfactionScore(null, '1.0000').outcome).toBe('NOT_CHECKED');
    expect(recomputeSatisfactionScore([], '1.0000').outcome).toBe('NOT_CHECKED');
  });
});

/**
 * CROSS-IMPLEMENTATION CHECK.
 *
 * `scripts/verify-trust-receipt.mjs` re-implements the canonical text on
 * purpose: a verifier that imports the code it verifies proves only that the
 * code agrees with itself. But two implementations that silently drift are
 * worse than one — the standalone would start accusing honest counterparties of
 * tampering.
 *
 * So the script is run as a SUBPROCESS (it cannot share module state) against a
 * fixture built from the same live-database row this file is pinned to, and its
 * verdict must agree: VERIFIED on the honest receipt, FAILED on a one-character
 * edit. Same shape as trinity-ecosystem's check-receipt-verifier.
 */
describe('the standalone verifier agrees with this port', () => {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const { writeFileSync, mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  const SCRIPT = join(__dirname, '..', 'scripts', 'verify-trust-receipt.mjs');
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'receipt-verify-')); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function runOn(receipt: unknown): { code: number; out: string } {
    const f = join(dir, `r-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(f, JSON.stringify(receipt));
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--file', f], { encoding: 'utf8' }) };
    } catch (e: any) {
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  const honest = {
    contract_id: '8de29497-380a-402a-ab48-5e93d3f43920',
    settled_at: '2026-09-04T09:00:55Z',
    price_usdc: '$0.05',
    buyer: 'trinity-torch',
    provider: 'trinity-shofet',
    settlement_tx: null,
    onchain_tx: null,
    reputation_events: [],
    work_statement_hash: LIVE_HASH,
    work_statement: LIVE_WS,
    criterion_ratings: [1, 2, 3, 4, 5, 6].map((n) => ({ n, met: false })),
    buyer_satisfaction_score: 0,
    caveats: [],
  };

  it('VERIFIES the honest receipt and exits 0', () => {
    const r = runOn(honest);
    expect(r.out).toMatch(/ok\s+work statement binding/);
    expect(r.out).toMatch(/ok\s+satisfaction score/);
    expect(r.code).toBe(0);
  });

  it('FAILS a one-character edit to the spec and exits 1 — same verdict as the port', () => {
    const tampered = {
      ...honest,
      work_statement: {
        ...LIVE_WS,
        acceptance_criteria: LIVE_WS.acceptance_criteria.map((c) =>
          c.n === 3 ? { ...c, text: c.text.replace('Minimum 8', 'Minimum 2') } : c,
        ),
      },
    };
    // The in-repo port says FAILED...
    expect(recomputeWorkStatementHash(tampered.work_statement, LIVE_HASH).outcome).toBe('FAILED');
    // ...and so must the standalone, independently.
    const r = runOn(tampered);
    expect(r.out).toMatch(/FAIL\s+work statement binding/);
    expect(r.code).toBe(1);
  });

  it('reports NOT_CHECKED (exit 2) rather than a pass when nothing is checkable', () => {
    const bare = { contract_id: 'x', reputation_events: [], caveats: [] };
    const r = runOn(bare);
    expect(r.out).toMatch(/NOT_CHECKED — nothing on this receipt could be checked/);
    expect(r.code).toBe(2);
  });
});
