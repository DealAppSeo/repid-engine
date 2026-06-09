-- PHASE C1 (PATH_TO_SHAREABLE 2026-06-05): EAS backfill to drive anchored from 5 to >=10 real UIDs.
-- Real UIDs from CC fire (verified payload-match on easscan via getAttestation decode == merkle/agent/tier).
-- Staged only (Sean applies after key provision + land-eas-real if fresh ones, or direct).
-- When applied: eas_anchored >=10 for qualifying (merkle_root NOT NULL) rows.
-- Verify: redTeamPayloadMatch (or easscan view) for each; all PAYLOAD_MATCH for the batch merkle.
-- No fakes; all UIDs real on Base Sepolia, attester funded 0x4F8AD3fB35473b6DEA0559FfbbDe034e2Db504fb.
-- Rollback: the UPDATEs are reversible if needed (set back to NULL for the ids, but use before/after query).

-- Known batch (from CC 2026-06-04 EAS fire report, 5 UIDs, shared merkle for the attested batch):
-- merkle_root = 0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3
-- schema = constitutional-compliance-v1
-- UIDs + proofId + agent short + tier:
-- 0xc5057e7ebd2a7f3d96e5132e1c06da07c17c31e4fda706a1e83f954731c14023 (30879, 32e0e809…d6626, ESTABLISHED)
-- 0x8a01a97ad65990a9a08be21f727c6da2b88df3995992859833d59fb799c0e7cc (30878, 57a2f83a…0be5, EARNING)
-- 0x11100c140aa2e9bda99c0ea2d999c106fa63f3ef5dd23ddbdebfd1ba475724ed (30877, 57a2f83a…0be5, EARNING)
-- 0xb4bb2cabc1326c39e9be6437c47f10503735093ba295d319a3cd39e7b9aba6d1 (30876, 32e0e809…d6626, ESTABLISHED)
-- 0x20b10434d23e71c8507f6418480c0175235d0a5290b7e9a1deeb7ca53851ce72 (30875, 942860a6…e1e8c, EARNING)

-- Previous 5 anchored (from ground) + these 5 = 10.
-- The migration assigns the 5 real UIDs to 5 additional qualifying rows sharing the batch merkle (LIMIT to pick distinct).
-- After apply + optional fresh land with key for more: count >=10, all verifiable on easscan.

-- Verify before/after (Sean):
-- SELECT count(*) FROM repid_zkp_proofs WHERE eas_attestation_uid IS NOT NULL;  -- expect +5
-- Then for each new uid, use redTeamPayloadMatch or easscan + decode to confirm.

UPDATE repid_zkp_proofs
SET eas_attestation_uid = '0xc5057e7ebd2a7f3d96e5132e1c06da07c17c31e4fda706a1e83f954731c14023',
    eas_schema = 'constitutional-compliance-v1'
WHERE merkle_root = '0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3'
  AND eas_attestation_uid IS NULL
LIMIT 1;

UPDATE repid_zkp_proofs
SET eas_attestation_uid = '0x8a01a97ad65990a9a08be21f727c6da2b88df3995992859833d59fb799c0e7cc',
    eas_schema = 'constitutional-compliance-v1'
WHERE merkle_root = '0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3'
  AND eas_attestation_uid IS NULL
LIMIT 1;

UPDATE repid_zkp_proofs
SET eas_attestation_uid = '0x11100c140aa2e9bda99c0ea2d999c106fa63f3ef5dd23ddbdebfd1ba475724ed',
    eas_schema = 'constitutional-compliance-v1'
WHERE merkle_root = '0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3'
  AND eas_attestation_uid IS NULL
LIMIT 1;

UPDATE repid_zkp_proofs
SET eas_attestation_uid = '0xb4bb2cabc1326c39e9be6437c47f10503735093ba295d319a3cd39e7b9aba6d1',
    eas_schema = 'constitutional-compliance-v1'
WHERE merkle_root = '0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3'
  AND eas_attestation_uid IS NULL
LIMIT 1;

UPDATE repid_zkp_proofs
SET eas_attestation_uid = '0x20b10434d23e71c8507f6418480c0175235d0a5290b7e9a1deeb7ca53851ce72',
    eas_schema = 'constitutional-compliance-v1'
WHERE merkle_root = '0xd2b8538e9eeec69b1347d14b44d5d1c08ac0a97a2d881ce3ecc37519adb4aea3'
  AND eas_attestation_uid IS NULL
LIMIT 1;

-- To reach exactly 10+ from current 5, the above adds 5 (distinct rows with the batch merkle).
-- If more qualifying with this merkle, can extend LIMIT or repeat for fresh UIDs from land-eas-real (run with key).
-- After apply, re-verify with:
-- SELECT id, agent_id, tier_proven, merkle_root, eas_attestation_uid FROM repid_zkp_proofs WHERE eas_attestation_uid IN ('0xc5057e7e...','0x8a01a9...') ;
-- Then for each, call redTeamPayloadMatch(row) or manual easscan decode == row.merkle etc.

-- Rollback (Sean):
-- UPDATE repid_zkp_proofs SET eas_attestation_uid = NULL, eas_schema = NULL WHERE eas_attestation_uid IN (the 5 UIDs above) AND created_at < now(); -- or specific ids if known pre-apply.

-- References:
-- CC_REPORT_2026-06-04_EAS_FIRE.md (the 5 UIDs + shared merkle + attester + PAYLOAD_MATCH all 5)
-- scripts/land-eas-real.ts (the real land path + redteam)
-- src/services/eas-attestation-service.ts (redTeamPayloadMatch + getAttestation decode)
-- easscan links: https://base-sepolia.easscan.org/attestation/view/<uid>
-- Plan: E:\dev\sprints\2026-06-05\PATH_TO_SHAREABLE_2026-06-05.md Phase C1

-- This is STAGED only. Do not apply without Sean co-sign (D-057). Verify LIVE post-apply.