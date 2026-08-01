/**
 * npm run ops:reconcile — report where the ledger and the money path disagree.
 *
 * REPORT-ONLY. Exits 1 when divergence is found, so it can gate a cron or CI.
 * It never writes: reconciling asserts an on-chain fact and needs a verified
 * receipt, not an inference from proximity in time.
 */
import { findSettlementOrphans, formatReconcileReport } from '../../src/services/settlement-reconciler';

(async () => {
  const report = await findSettlementOrphans();
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatReconcileReport(report));
  process.exit(report.healthy ? 0 : 1);
})().catch((e) => {
  console.error('reconcile failed:', e instanceof Error ? e.message : e);
  process.exit(2);
});
