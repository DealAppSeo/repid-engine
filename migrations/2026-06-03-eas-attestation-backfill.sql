-- R2 Phase 1 backfill (use ONLY if real drain attest with funded key not yet run, or to seed examples).
-- After schema verify (types + this migration applied via apply_migration).
-- Populates eas_attestation_uid on some merkle rows with REAL UIDs from our attest flow (not borrowed).
-- Sean co-sign + funded key first. Then run scripts/land-eas-real.ts to generate own + red-team.
-- If using this DML with example UIDs, replace them immediately with own red-teamed ones.
-- Gate: post live SELECT count(*) FROM repid_zkp_proofs WHERE eas_attestation_uid IS NOT NULL; >=5+ own.

-- Example: UPDATE qualifying rows (run the land script instead for real tx-backed UIDs).
-- The UIDs below are placeholders from prior; DO NOT leave borrowed in prod.
-- UPDATE public.repid_zkp_proofs SET eas_attestation_uid = '0x<own-from-land-script>', eas_schema = 'constitutional-compliance-v1'
-- WHERE id IN (SELECT id FROM public.repid_zkp_proofs WHERE merkle_root IS NOT NULL AND eas_attestation_uid IS NULL LIMIT 5);

-- After real run: the 5+ UIDs + https://base-sepolia.easscan.org/attestation/view/<uid> go in XC_REPORT_2026-06-03_R2.md
-- Red-team evidence (payload match) also recorded there.
-- Recommend: delete this file after successful land + report (or archive with note).
