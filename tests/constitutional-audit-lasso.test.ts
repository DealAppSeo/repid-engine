import { performance } from 'perf_hooks';

jest.mock('../src/db', () => ({ db: {} }));

import { selectRelevantRulesLasso } from '../src/layers/constitutional-audit';

const RULES = {
  accuracy: 'Verify factual claims and never fabricate citations.',
  authorization: 'Require explicit authorization before deleting files or data.',
  privacy: 'Do not disclose private keys, credentials, or personal data.',
  payments: 'Require confirmation before sending money or signing transactions.',
  deletion: 'Use recoverable deletion and validate the exact target path.',
  fairness: 'Apply the same standard regardless of identity or viewpoint.',
  transparency: 'State uncertainty and distinguish measurements from estimates.',
  uptime: 'Keep health probes and service monitoring operational.',
  review: 'Run tests and request review before deploying changes.',
};

describe('constitutional audit LASSO rule selection', () => {
  it('returns a deterministic sparse subset containing action-relevant rules', () => {
    const first = selectRelevantRulesLasso(RULES, 'MCP_CALL:delete_file');
    const second = selectRelevantRulesLasso(RULES, 'MCP_CALL:delete_file');

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(5);
    expect(first.length).toBeLessThan(Object.keys(RULES).length);
    expect(first).toContain('deletion');
  });

  it('uses rule values, not only rule identifiers, to establish relevance', () => {
    const selected = selectRelevantRulesLasso(RULES, 'SEND_TRANSACTION_PAYMENT');
    expect(selected).toContain('payments');
  });

  it('averages under the five millisecond selection budget', () => {
    for (let i = 0; i < 20; i++) selectRelevantRulesLasso(RULES, 'MCP_CALL:delete_file');
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      selectRelevantRulesLasso(RULES, 'MCP_CALL:delete_file');
    }
    const averageMs = (performance.now() - started) / 200;
    expect(averageMs).toBeLessThan(5);
  });

  it('returns every rule when the constitution has fewer than three rules', () => {
    expect(selectRelevantRulesLasso({ honesty: 'Be honest', safety: 'Avoid harm' }, 'AUDIT'))
      .toEqual(['honesty', 'safety']);
  });

  it('still returns a strict subset when the constitution has four or five rules', () => {
    expect(selectRelevantRulesLasso({
      one: 'first rule', two: 'second rule', three: 'third rule', four: 'fourth rule',
    }, 'first')).toHaveLength(3);
    expect(selectRelevantRulesLasso({
      one: 'first rule', two: 'second rule', three: 'third rule', four: 'fourth rule',
      five: 'fifth rule',
    }, 'first')).toHaveLength(3);
  });
});
