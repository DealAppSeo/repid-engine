/**
 * Settlement provenance.
 *
 * Asked "how many completed transactions?", this system could answer 106, 44 or 7 —
 * all true, about different things, and none defensible when checked against the chain.
 *
 * The live split is a clean instrumentation cutover [V 2026-08-04]:
 *   2026-05-15..07-02 — 62 real settlements, 0 with a hash
 *   2026-07-03..08-02 — 44 real settlements, 44 with a hash
 *
 * These tests pin the classification, and above all that a row with no on-chain
 * evidence can never be counted as proven — whatever else is true about it.
 */

import {
  TX_HASH_INSTRUMENTATION_DATE,
  classifySettlement,
  formatProvenance,
  summariseProvenance,
  type SettlementRow,
} from '../src/services/settlement-provenance';

const row = (over: Partial<SettlementRow> = {}): SettlementRow => ({
  id: 's1',
  is_simulated: false,
  tx_hash: '0x' + 'ab'.repeat(32),
  created_at: '2026-08-01T00:00:00.000Z',
  status: 'settled',
  ...over,
});

describe('the only class that may be called proven', () => {
  it('real money plus a hash is PROVEN_ONCHAIN and countable', () => {
    const a = classifySettlement(row());
    expect(a.provenance).toBe('PROVEN_ONCHAIN');
    expect(a.countableAsProven).toBe(true);
    expect(a.txHash).toMatch(/^0x/);
  });

  it('THE INVARIANT: nothing without a hash is ever countable as proven', () => {
    const noHash: SettlementRow[] = [
      row({ tx_hash: null, created_at: '2026-05-20T00:00:00.000Z' }),
      row({ tx_hash: null, created_at: '2026-08-01T00:00:00.000Z' }),
      row({ tx_hash: '   ', created_at: '2026-08-01T00:00:00.000Z' }),
      row({ tx_hash: null, created_at: null }),
      row({ tx_hash: null, is_simulated: true }),
    ];
    for (const r of noHash) expect(classifySettlement(r).countableAsProven).toBe(false);
  });

  it('a blank or whitespace hash is not a hash', () => {
    expect(classifySettlement(row({ tx_hash: '' })).countableAsProven).toBe(false);
    expect(classifySettlement(row({ tx_hash: '   ' })).countableAsProven).toBe(false);
  });
});

describe('the instrumentation cutover', () => {
  it('a real settlement BEFORE the cutover is historical, not a fault', () => {
    const a = classifySettlement(row({ tx_hash: null, created_at: '2026-06-24T12:00:00.000Z' }));
    expect(a.provenance).toBe('UNPROVABLE_PRE_INSTRUMENTATION');
    expect(a.reason).toMatch(/never backfilled by guessing/);
  });

  it('THE ONE ALARMING CLASS: real with no hash AFTER the cutover is a regression', () => {
    const a = classifySettlement(row({ tx_hash: null, created_at: '2026-08-01T00:00:00.000Z' }));
    expect(a.provenance).toBe('CLAIMS_REAL_NO_PROOF');
    expect(a.reason).toMatch(/regressed/);
  });

  it('the boundary date counts as POST-cutover — the first hash-bearing row is on it', () => {
    // Treating the boundary as "before" would misclassify a genuinely proven payment as
    // unprovable. Erring strict would be safe for a claim and wrong about a fact.
    const a = classifySettlement(row({ tx_hash: null, created_at: `${TX_HASH_INSTRUMENTATION_DATE}T00:00:00.000Z` }));
    expect(a.provenance).toBe('CLAIMS_REAL_NO_PROOF');
  });

  it('an undatable row is treated as CURRENT, not assumed old', () => {
    // An undatable row could equally be a fresh regression. Assuming it is history
    // would hide exactly the case this module exists to surface.
    for (const created_at of [null, 'whenever', '']) {
      expect(classifySettlement(row({ tx_hash: null, created_at })).provenance).toBe('CLAIMS_REAL_NO_PROOF');
    }
  });
});

describe('simulated rows, and unknown flags', () => {
  it('explicitly simulated is never a payment', () => {
    expect(classifySettlement(row({ is_simulated: true })).provenance).toBe('SIMULATED');
  });

  it('an UNKNOWN is_simulated is treated as simulated, never promoted to real', () => {
    // Unearned confidence is the whole failure mode. A null flag must not create a
    // payment out of nothing — even when a hash is present.
    for (const v of [null, undefined]) {
      const a = classifySettlement(row({ is_simulated: v as unknown as boolean }));
      expect(a.provenance).toBe('SIMULATED');
      expect(a.countableAsProven).toBe(false);
    }
  });
});

describe('the summary reproduces the live shape', () => {
  const live = [
    ...Array.from({ length: 62 }, (_, i) =>
      row({ id: `old${i}`, tx_hash: null, created_at: '2026-06-01T00:00:00.000Z' }),
    ),
    ...Array.from({ length: 44 }, (_, i) => row({ id: `new${i}`, created_at: '2026-07-20T00:00:00.000Z' })),
  ];

  it('106 rows -> 44 proven, 62 historical, 0 regressions', () => {
    const s = summariseProvenance(live);
    expect(s.total).toBe(106);
    expect(s.provenPayments).toBe(44);
    expect(s.unprovableHistorical).toBe(62);
    expect(s.regressions).toBe(0);
  });

  it('the headline volunteers the weaker number, which is what makes the stronger one believable', () => {
    const s = summariseProvenance(live);
    expect(s.headline).toMatch(/44 payment\(s\) are provable on-chain/);
    expect(s.headline).toMatch(/62/);
    expect(s.headline).toMatch(/not counted as proven/);
  });

  it('one regression changes the headline to a warning, not a count', () => {
    const s = summariseProvenance([...live, row({ id: 'bad', tx_hash: null, created_at: '2026-08-03T00:00:00.000Z' })]);
    expect(s.regressions).toBe(1);
    expect(s.headline).toMatch(/recorder has regressed/);
    expect(s.headline).toMatch(/before quoting any figure/);
  });

  it('an empty set claims nothing', () => {
    expect(summariseProvenance([]).provenPayments).toBe(0);
  });

  it('the rendered block marks which number to quote, and flags a healthy recorder', () => {
    const out = formatProvenance(summariseProvenance(live));
    expect(out).toMatch(/the number to quote/);
    expect(out).toMatch(/the recorder is working/);
  });
});

describe('this module cannot alter the ledger', () => {
  it('has no database import and no write verb', () => {
    // It answers a question about rows; it must never be able to change one, least of
    // all to make an unprovable row look proven.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'services', 'settlement-provenance.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]\.\.\/db['"]/);
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
  });
});
