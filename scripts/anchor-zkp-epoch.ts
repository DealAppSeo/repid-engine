/**
 * Operator entrypoint for ZKP epoch anchoring (sprint 2026-05-29, continues PR #73).
 *
 * Usage:
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD]                 # DRY-RUN (default): preview, NO writes
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD] --apply         # writes merkle_root to repid_zkp_proofs ONLY
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD] --scheme sha256 # hash-agnostic root (default keccak256)
 *   ts-node scripts/anchor-zkp-epoch.ts [YYYY-MM-DD] --after <id>    # post-nonce CUTOFF: only proofs id > <id>
 *
 * DRY-RUN BY DEFAULT (mirrors the decay-loop operator pattern): prints the epoch
 * preview, the broadcast-ready EAS attestation, and the EXACT Sean on-chain
 * command — and writes NOTHING. `--apply` persists merkle_root only.
 *
 * On-chain send is NEVER done here — that is Sean-only (Railway/keys/funds). This
 * script prepares the command block; Sean runs it.
 *
 * DECONFLICTION: touches repid_zkp_proofs ONLY (never repid_score_events,
 * repid_agents, the RepID sync, compute_tier, or HAL code).
 */
import { dayEpoch, aggregateEpoch, buildEasAttestationRequest, buildSeanCommand, verifyProofViaAnchor } from '../src/services/zkp-epoch-anchor';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dateArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const apply = process.argv.includes('--apply');
  const schemeName = argVal('--scheme');
  const afterId = argVal('--after') ? parseInt(argVal('--after')!, 10) : undefined;
  const date = dateArg ? new Date(`${dateArg}T12:00:00.000Z`) : new Date();
  const epoch = dayEpoch(date);

  console.log(`[zkp-anchor] epoch=${epoch.label} mode=${apply ? 'APPLY (writes merkle_root)' : 'DRY-RUN (no writes)'} scheme=${schemeName ?? 'keccak256'}${afterId ? ` afterId=${afterId}` : ''}`);

  const agg = await aggregateEpoch(epoch, { persist: apply, schemeName, afterId });
  console.log(JSON.stringify({
    epoch: agg.epoch, proof_count: agg.proof_count, distinct_commitments: agg.distinct_commitments,
    scheme: agg.scheme, merkle_root: agg.root, first_id: agg.first_id, last_id: agg.last_id,
    persisted: agg.persisted, rows_updated_merkle: agg.rows_updated,
  }, null, 2));

  if (agg.proof_count === 0) { console.log('[zkp-anchor] no proofs in epoch — nothing to anchor.'); return; }

  // Soundness caveat: duplicate leaves until the PR #74 nonce fix is live.
  if (agg.distinct_commitments < agg.proof_count) {
    console.warn(`\n⚠️  ${agg.proof_count - agg.distinct_commitments}/${agg.proof_count} leaves are DUPLICATE commitments ` +
      `(${agg.distinct_commitments} distinct). The PR #74 nonce fix is not yet live for this epoch — the root is ` +
      `well-formed but NOT per-proof-sound. Use --after <cutoff_id> once unique commitments begin, or anchor after deploy.`);
  }

  const eas = buildEasAttestationRequest({ root: agg.root, epoch: agg.epoch, proofCount: agg.proof_count, firstId: agg.first_id ?? 0, lastId: agg.last_id ?? 0 });
  console.log('\n--- EAS attestation (broadcast-ready) ---');
  console.log(`eas_contract: ${eas.easContract}`);
  console.log(`schema_uid:   ${eas.schemaUid}`);
  console.log(`calldata:     ${eas.attestCalldata.slice(0, 76)}…`);

  console.log('\n--- SEAN ON-CHAIN COMMAND (do NOT run unattended) ---');
  console.log(buildSeanCommand(eas, { firstId: agg.first_id ?? 0, lastId: agg.last_id ?? 0, idCount: agg.proof_count }));

  if (apply && agg.rows_updated > 0) {
    const v = await verifyProofViaAnchor(agg.ids[0]!);
    console.log(`\n[verify-back] proof ${agg.ids[0]} → verified=${v.verified} tier=${v.tier_proven}`);
  } else {
    console.log('\n[zkp-anchor] DRY-RUN — re-run with --apply to persist merkle_root.');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
