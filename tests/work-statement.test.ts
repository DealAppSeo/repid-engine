/**
 * ZK BIND T1 — the binding hash is only worth anything if it is deterministic,
 * collision-resistant across field boundaries, and sensitive to every fact it
 * claims to cover. Each test below is an attack on one of those.
 */
import {
  workStatementHash,
  workStatementPreimage,
  verifyWorkStatement,
  canonicalJson,
  WORK_STATEMENT_DOMAIN,
  type WorkStatementInput,
} from '../src/services/work-statement';

const base: WorkStatementInput = {
  contract_id: '97c2d308-b6e7-4900-bcea-dd43a4aacb46',
  service_id: 'svc-1',
  buyer_agent_id: 'buyer-1',
  provider_agent_id: 'prov-1',
  agreed_price_usdc_raw: 100000,
  settlement_tx: '0x588f905a',
  verdict: 'PASS',
  satisfaction_score: 0.95,
  payload: { task: 'verify a claim' },
  result: { verdict: 'PASS', evidence: ['https://example.com'] },
};

describe('determinism', () => {
  it('is stable across calls', () => {
    expect(workStatementHash(base)).toBe(workStatementHash({ ...base }));
  });

  it('does NOT depend on JSON key order', () => {
    // Two rows built in different order must bind identically, or the hash
    // depends on how a row happened to be constructed rather than on its facts.
    const reordered: WorkStatementInput = {
      ...base,
      payload: JSON.parse('{"task":"verify a claim"}'),
      result: { evidence: ['https://example.com'], verdict: 'PASS' },
    };
    expect(workStatementHash(reordered)).toBe(workStatementHash(base));
  });

  it('canonical JSON sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('normalises verdict case and satisfaction precision', () => {
    expect(workStatementHash({ ...base, verdict: 'pass' })).toBe(workStatementHash(base));
    expect(workStatementHash({ ...base, satisfaction_score: 0.95000001 })).toBe(workStatementHash(base));
  });
});

describe('every covered fact changes the hash', () => {
  const mutations: Array<[string, Partial<WorkStatementInput>]> = [
    ['contract_id', { contract_id: 'other' }],
    ['provider', { provider_agent_id: 'someone-else' }],
    ['buyer', { buyer_agent_id: 'someone-else' }],
    ['price', { agreed_price_usdc_raw: 100001 }],
    ['settlement tx', { settlement_tx: '0xdifferent' }],
    ['verdict', { verdict: 'FAIL' }],
    ['satisfaction', { satisfaction_score: 0.5 }],
    ['payload', { payload: { task: 'something else' } }],
    ['result', { result: { verdict: 'PASS', evidence: [] } }],
  ];
  for (const [name, patch] of mutations) {
    it(`changing ${name} changes the binding`, () => {
      expect(workStatementHash({ ...base, ...patch })).not.toBe(workStatementHash(base));
    });
  }
});

describe('field-boundary collisions', () => {
  it('cannot be forged by shifting characters between adjacent fields', () => {
    // Without length prefixes ("ab","c") and ("a","bc") serialise identically,
    // so two different exchanges could share one binding. This is the attack
    // that makes naive concatenation unsafe.
    const a = workStatementHash({ ...base, buyer_agent_id: 'ab', provider_agent_id: 'c' });
    const b = workStatementHash({ ...base, buyer_agent_id: 'a', provider_agent_id: 'bc' });
    expect(a).not.toBe(b);
  });

  it('is domain-separated so it cannot collide with another digest', () => {
    expect(workStatementPreimage(base).startsWith(`${WORK_STATEMENT_DOMAIN.length}:${WORK_STATEMENT_DOMAIN}`)).toBe(true);
  });
});

describe('privacy', () => {
  it('the preimage carries digests, never the work itself', () => {
    const secret = 'CONFIDENTIAL-DELIVERABLE-BODY';
    const pre = workStatementPreimage({ ...base, result: { answer: secret }, payload: { q: secret } });
    // The hash is published on a public receipt; the work is not.
    expect(pre).not.toContain(secret);
  });
});

describe('verification', () => {
  it('confirms a matching binding', () => {
    const r = verifyWorkStatement(base, workStatementHash(base));
    expect(r.matches).toBe(true);
    expect(r.reason).toMatch(/bound to this work/);
  });

  it('detects an exchange edited after the hash was recorded', () => {
    const stored = workStatementHash(base);
    const r = verifyWorkStatement({ ...base, result: { verdict: 'PASS', evidence: ['tampered'] } }, stored);
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/MISMATCH/);
  });

  it('reports an UNBOUND proof rather than quietly passing', () => {
    const r = verifyWorkStatement(base, null);
    expect(r.matches).toBe(false);
    expect(r.reason).toMatch(/NOT bound/);
  });

  it('is case-insensitive on the stored hex but not on the value', () => {
    const h = workStatementHash(base);
    expect(verifyWorkStatement(base, h.toUpperCase()).matches).toBe(true);
    expect(verifyWorkStatement(base, h.replace(/.$/, '0')).matches).toBe(false);
  });
});
