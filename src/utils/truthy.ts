/**
 * Shared truthy-flag normalizer for the gas-discipline `is_simulated` control.
 *
 * Background — CC2 ATTACKER F-series (2026-05-22, see
 * E:\dev\reports\2026-05-22\CC2_ATTACKER_F_SERIES_RESULTS.md): the
 * `is_simulated` gate was checked with `=== true || === 'true'` at three sites
 * (bridge derivation, SQL poll gate, JS re-check). So non-canonical flag values
 * — `"True"`, `"TRUE"`, `1`, `"1"`, `"yes"` (F1/F2) and a nested/mislocated
 * `is_simulated` (F4) — slipped through and could mint a REAL on-chain
 * attestation for a simulated contract. These helpers normalize all of them.
 */

/**
 * Scalar normalizer. TRUE for boolean `true` or a string/number that
 * case-insensitively equals one of `true` / `1` / `yes` (after trim).
 * Everything else (false, 0, "no", null, undefined, "", objects) is falsy.
 */
export function isTruthyFlag(v: unknown): boolean {
  return v === true || ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());
}

/**
 * Object-aware variant: TRUE if `obj.is_simulated` is truthy per isTruthyFlag,
 * OR any nested object carries a truthy `is_simulated` (bounded depth — closes
 * F4 mislocation). Depth-capped to guard against pathological/circular inputs.
 */
export function hasTruthySimFlag(obj: unknown, _depth = 0): boolean {
  if (_depth > 4 || obj === null || typeof obj !== 'object') return false;
  const rec = obj as Record<string, unknown>;
  if ('is_simulated' in rec && isTruthyFlag(rec.is_simulated)) return true;
  for (const k of Object.keys(rec)) {
    const val = rec[k];
    if (val !== null && typeof val === 'object' && hasTruthySimFlag(val, _depth + 1)) return true;
  }
  return false;
}
