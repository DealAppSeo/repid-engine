/**
 * Operator entrypoint for ZKP epoch anchoring (sprint 2026-05-29).
 *
 * Usage:
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD]        # aggregate + prepare EAS (deferred)
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD] --send # also broadcast (Sean-only; needs key+funds)
 *
 * Default (no --send): aggregates the epoch's POSTCARD proofs into one merkle_root
 * (back-filled across the epoch's rows) and PRINTS the broadcast-ready EAS
 * attestation request + the exact on-chain action — which is Sean's to run.
 *
 * --send only broadcasts if AUDIT_ANCHOR_PRIVATE_KEY/DEPLOYER_PRIVATE_KEY is set
 * (Sean-only); otherwise it stops at the prepared request. No real funds move
 * without an explicitly-provided key.
 */
import { dayEpoch, anchorEpoch, verifyProofViaAnchor } from '../src/services/zkp-epoch-anchor';

async function main() {
  const dateArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const send = process.argv.includes('--send');
  const date = dateArg ? new Date(`${dateArg}T12:00:00.000Z`) : new Date();
  const epoch = dayEpoch(date);

  console.log(`[zkp-anchor] epoch=${epoch.label} send=${send}`);
  const result = await anchorEpoch(epoch, { persist: true, sendOnChain: send });

  console.log(JSON.stringify({
    status: result.status,
    epoch: result.epoch,
    proof_count: result.proof_count,
    merkle_root: result.root,
    rows_updated_merkle: result.rows_updated_merkle,
    eas_attestation_uid: result.eas_attestation_uid,
    rows_updated_eas: result.rows_updated_eas,
  }, null, 2));

  if (result.eas) {
    console.log('\n--- EAS attestation (broadcast-ready) ---');
    console.log(`eas_contract: ${result.eas.easContract}`);
    console.log(`schema_uid:   ${result.eas.schemaUid}`);
    console.log(`schema:       ${result.eas.schemaString}`);
    console.log(`domain:       ${result.eas.domain}`);
    console.log(`calldata:     ${result.eas.attestCalldata.slice(0, 76)}…`);
    console.log(`\n${result.eas.seanAction}`);
  }

  // Smoke the verify-back loop on the first proof of the epoch (when aggregated).
  if (result.status !== 'no_proofs' && result.rows_updated_merkle > 0) {
    const agg = await import('../src/services/zkp-epoch-anchor');
    const r = await agg.computeEpochMerkleRoot(epoch);
    if (r.ids.length > 0) {
      const v = await verifyProofViaAnchor(r.ids[0]!);
      console.log(`\n[verify-back] proof ${r.ids[0]} → verified=${v.verified} tier=${v.tier_proven}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
