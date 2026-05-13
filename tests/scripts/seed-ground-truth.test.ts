/**
 * CC Sprint 10 Phase 5.4 — Tests for HAL ground-truth seeding tool.
 * Pure tests for parsing + formatting; the DB-touching paths (seedFromCsv,
 * seedInteractive) are covered by `--stats` smoke runs against live Supabase.
 */

import { parseCsv, formatStats, TEMPLATE_CSV } from '../../scripts/hal/seed-ground-truth';

describe('parseCsv', () => {
  it('parses valid CSV with header + rows', () => {
    const csv = [
      'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by,rationale',
      'hal_runner_results,abc-1,true,0.9,sean,Made up fact',
      'hal_runner_results,def-2,false,0.85,sean,Factual',
    ].join('\n');
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      source_table: 'hal_runner_results',
      source_id: 'abc-1',
      is_hallucination: true,
      ground_truth_confidence: 0.9,
      labeled_by: 'sean',
      rationale: 'Made up fact',
    });
    expect(rows[1]!.is_hallucination).toBe(false);
  });

  it('accepts y/n/1/0/yes/no/t/f for is_hallucination', () => {
    const csv = [
      'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by',
      'hal_runner_results,a,yes,0.5,sean',
      'hal_runner_results,b,no,0.5,sean',
      'hal_runner_results,c,1,0.5,sean',
      'hal_runner_results,d,0,0.5,sean',
      'hal_runner_results,e,t,0.5,sean',
      'hal_runner_results,f,f,0.5,sean',
    ].join('\n');
    const rows = parseCsv(csv);
    expect(rows.map((r) => r.is_hallucination)).toEqual([true, false, true, false, true, false]);
  });

  it('rejects invalid source_table', () => {
    const csv = [
      'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by',
      'fake_table,a,true,0.5,sean',
    ].join('\n');
    expect(() => parseCsv(csv)).toThrow(/invalid source_table/);
  });

  it('rejects out-of-range confidence', () => {
    const csv = [
      'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by',
      'hal_runner_results,a,true,1.5,sean',
    ].join('\n');
    expect(() => parseCsv(csv)).toThrow(/ground_truth_confidence/);
  });

  it('rejects missing required column', () => {
    const csv = [
      'source_table,source_id,labeled_by',
      'hal_runner_results,a,sean',
    ].join('\n');
    expect(() => parseCsv(csv)).toThrow(/missing required column/);
  });

  it('handles quoted rationale with commas', () => {
    const csv = [
      'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by,rationale',
      'hal_runner_results,a,true,0.9,sean,"Made up, fake, multi-clause"',
    ].join('\n');
    const rows = parseCsv(csv);
    expect(rows[0]!.rationale).toBe('Made up, fake, multi-clause');
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('formatStats', () => {
  it('shows zero-label hint when total=0', () => {
    const s = formatStats({ total: 0, by_labeled_by: [], by_source_table: [], by_is_hallucination: [] });
    expect(s).toContain('0 total');
    expect(s).toContain('no labels yet');
  });
  it('formats breakdowns when total > 0', () => {
    const s = formatStats({
      total: 12,
      by_labeled_by: [{ labeled_by: 'sean', cnt: 10 }, { labeled_by: 'gpt4-judge', cnt: 2 }],
      by_source_table: [{ source_table: 'hal_runner_results', cnt: 12 }],
      by_is_hallucination: [{ is_hallucination: true, cnt: 7 }, { is_hallucination: false, cnt: 5 }],
    });
    expect(s).toContain('12 total');
    expect(s).toContain('sean');
    expect(s).toContain('gpt4-judge');
  });
});

describe('TEMPLATE_CSV', () => {
  it('includes header + comment hints', () => {
    expect(TEMPLATE_CSV).toContain('source_table,source_id,is_hallucination');
    expect(TEMPLATE_CSV).toContain('# Valid source_table values');
  });
});
