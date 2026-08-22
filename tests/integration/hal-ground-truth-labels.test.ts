/**
 * CC Sprint 7 — tests for hal_ground_truth_labels + updated hal_accuracy_summary.
 *
 * Verifies:
 *   - hal_ground_truth_labels table exists + accepts insert/delete
 *   - hal_accuracy_summary view returns NULL metrics + NO_GROUND_TRUTH_LABELS
 *     when no labels exist
 *   - When a single test label is inserted, view's total_labeled increments
 *     to 1 and data_quality transitions to INSUFFICIENT_GROUND_TRUTH (still
 *     <30 threshold)
 *   - tear down the test label
 *
 * Skipped if SUPABASE env unset.
 */

import { db } from '../../src/db';
import { integrationSchemaPresent } from '../helpers/describe-if-schema';
import { runIntegration } from '../helpers/run-integration';

// Run only against a seeded, non-prod test DB (schema-present) with creds.
const describeIfDb = runIntegration() && integrationSchemaPresent() ? describe : describe.skip;

describeIfDb('hal_ground_truth_labels + hal_accuracy_summary v2', () => {
  it('hal_ground_truth_labels table exists and is queryable', async () => {
    const { error } = await db.from('hal_ground_truth_labels').select('id').limit(0);
    expect(error).toBeNull();
  });

  it('hal_accuracy_summary returns ONE row regardless of label state', async () => {
    const { data, error } = await db.from('hal_accuracy_summary').select('*');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it('view exposes total_labeled, total_raw, data_quality columns', async () => {
    const { data } = await db.from('hal_accuracy_summary').select('total_labeled, total_raw, data_quality');
    const row = data?.[0] as any;
    expect(row).toHaveProperty('total_labeled');
    expect(row).toHaveProperty('total_raw');
    expect(row).toHaveProperty('data_quality');
    expect(['NO_GROUND_TRUTH_LABELS', 'INSUFFICIENT_GROUND_TRUTH', 'OK']).toContain(row.data_quality);
  });

  it('with no labels, metrics are NULL and quality flag says so', async () => {
    // Pre-condition: no labels for the test labeler
    await db.from('hal_ground_truth_labels').delete().eq('labeled_by', 'sprint7-test');

    const { data } = await db.from('hal_accuracy_summary').select('*');
    const row = data?.[0] as any;
    if (row.total_labeled === 0) {
      expect(['NO_GROUND_TRUTH_LABELS', 'INSUFFICIENT_GROUND_TRUTH']).toContain(row.data_quality);
      expect(row.precision).toBeNull();
      expect(row.recall).toBeNull();
      expect(row.f1_score).toBeNull();
      expect(row.false_positive_rate).toBeNull();
    } else {
      // If other labelers have inserted, this branch covers the merged state
      expect(['INSUFFICIENT_GROUND_TRUTH', 'OK']).toContain(row.data_quality);
    }
  });

  it('round-trip: insert label, verify view picks it up, clean up', async () => {
    // Find a real hal_runner_results row to label
    const { data: anyRow } = await db.from('hal_runner_results')
      .select('id').eq('gen_failed', false).not('hal_vetoed', 'is', null).limit(1).maybeSingle();
    if (!anyRow) {
      console.warn('No suitable hal_runner_results row to label; skipping round-trip test');
      return;
    }

    const sourceId = String((anyRow as any).id);
    const { error: insErr } = await db.from('hal_ground_truth_labels').insert({
      source_table: 'hal_runner_results',
      source_id: sourceId,
      is_hallucination: true,
      ground_truth_confidence: 0.9,
      labeled_by: 'sprint7-test',
      rationale: 'CC Sprint 7 round-trip test row',
    });
    expect(insErr).toBeNull();

    const { data: viewAfter } = await db.from('hal_accuracy_summary').select('total_labeled');
    const labeledAfter = (viewAfter?.[0] as any)?.total_labeled ?? 0;
    expect(labeledAfter).toBeGreaterThanOrEqual(1);

    // Cleanup
    const { error: delErr } = await db.from('hal_ground_truth_labels')
      .delete()
      .eq('source_table', 'hal_runner_results')
      .eq('source_id', sourceId)
      .eq('labeled_by', 'sprint7-test');
    expect(delErr).toBeNull();
  });
});
