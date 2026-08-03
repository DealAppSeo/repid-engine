/**
 * repid-delta-bridge.ts — the wire between the live scoring path and the ZKP RepID
 * statement.
 *
 * `repid-delta-statement.ts` is pure and knows nothing about the pipeline. This module
 * is the only place that knows both, and it exists so the statement layer stays
 * testable without a database and the pipeline gains exactly one call site.
 *
 * ## What it does, in order of how much it is worth today
 *
 * 1. **Detects deltas that never came from the formula.** This is the immediate value,
 *    ahead of any cryptography. Seven of eleven score-event writers are unguarded, so a
 *    delta reaching `repid_score_events` without passing through `computeDelta` is a
 *    thing that happens rather than a thing we fear. In `shadow` this is a loud log; it
 *    needs no circuit, no key, and no schema change to be useful.
 *
 * 2. **Fixes the statement format before a circuit is written against it.** A Plonky3
 *    circuit built against a statement that later gets reordered verifies nothing and
 *    fails silently. Freezing the canonical digest first is the cheap ordering.
 *
 * 3. **Records the statement** (`on` only), so an epoch of deltas can be audited by an
 *    outside developer against one formula commitment.
 *
 * ## Three modes, default OFF
 * `off`     — byte-identical to today. Not a single extra field element is hashed.
 * `shadow`  — build the statement, log inconsistencies, PERSIST NOTHING.
 * `on`      — additionally insert a `REPID_DELTA` row.
 *
 * Default off because building a statement runs Poseidon2 on every score event, and
 * that cost belongs in a measurement before it belongs in a write path.
 *
 * ## TWO SECRETS, TWO JOBS (changed 2026-08-03)
 * `REPID_FORMULA_COMMITMENT_SALT` hides the scoring formula. `REPID_IDENTITY_MASTER_SECRET`
 * backs the nullifier. They were ONE secret and that was a defect, not a shortcut —
 * see `resolveIdentitySecret` below and `nullifier-identity.ts` for the full account.
 * Neither has a default and neither degrades quietly: with either missing, shadow/on
 * builds nothing and says which variable is absent.
 *
 * ## HONEST LABELLING IS LOAD-BEARING
 * Rows written here carry `proof_type='REPID_DELTA'`, `scheme='poseidon2-statement-v1'`,
 * `is_real=false`, `proof_bytes=NULL`. There is no proof. The 56,823 sha256 stub rows
 * that got counted as proofs for weeks are the reason this is spelled out in three
 * places instead of one.
 *
 * ## NEVER THROWS INTO THE CALLER
 * A lineage/audit artefact must not be able to fail a score write. Every path is
 * caught, logged, and returns a result the caller can ignore. Same contract as
 * `leaf-dual-write.ts`.
 */

import { db } from '../db';
import {
  REPID_DELTA_DOMAIN,
  REPID_DELTA_STATEMENT_SCHEME,
  buildRepidDeltaStatement,
  deltaStatementMode,
  formulaSalt,
  type DeltaStatementMode,
  type RepidDeltaPublicInputs,
} from './repid-delta-statement';
import {
  IDENTITY_MASTER_ENV,
  deriveIdentitySecret,
  identityMaster,
  identitySecretFromHolderSeed,
  type IdentitySecret,
  type UnlinkabilityStatement,
} from './nullifier-identity';
import type { HALDecision } from '../scoring/repid-delta';

export interface DeltaBridgeInput {
  agentId: string;
  /** The score-event id, or any stable per-event label. Scopes the nullifier. */
  eventLabel: string;
  /** Values AS THEY WILL BE STORED — integers. See the statement module on rounding. */
  deltaApplied: number;
  scoreBefore: number;
  scoreAfter: number;
  halScore: number;
  halDecision: HALDecision;
  agentTier: string;
  vestingCliffActive: boolean;
  taskComplexity?: number;
  /**
   * OPTIONAL holder-derived nullifier seed, >=32 bytes of hex.
   *
   * When present the nullifier secret comes from the holder and the engine master is
   * not used, which is the only configuration where the nullifier is unlinkable by the
   * operator as well as by the public. The live scoring pipeline has no holder in the
   * loop, so it never passes this today; the parameter exists so that when
   * `human_agent_bindings` starts carrying real rows the wire is already the right
   * shape. Never persisted — see `nullifier-identity.ts`.
   */
  identitySeedHex?: string;
}

export interface DeltaBridgeResult {
  mode: DeltaStatementMode;
  /** Built statement, or null when the mode is off or the build failed. */
  statement: RepidDeltaPublicInputs | null;
  /** True when the applied delta follows from the formula. */
  consistent: boolean | null;
  inconsistency: string | null;
  persisted: boolean;
  /** Why nothing happened, when nothing happened. Never a silent no-op. */
  skipped: string | null;
  /** Who can and cannot link this nullifier. Null when no statement was built. */
  unlinkability: UnlinkabilityStatement | null;
}

const inert = (mode: DeltaStatementMode, skipped: string | null): DeltaBridgeResult => ({
  mode,
  statement: null,
  consistent: null,
  inconsistency: null,
  persisted: false,
  skipped,
  unlinkability: null,
});

/**
 * Resolve the nullifier secret for this event (Invariant 2).
 *
 * ## What this replaced
 * The previous version folded `${formula_salt}|${eventLabel}` through a 131-multiplier
 * rolling hash mod p. Three separate problems, in ascending order of severity:
 *   1. the secret keyed the per-EVENT axis, so "one identity, many scopes" — the thing
 *      Invariant 2 is about, and what the health vertical needs — had no encoding;
 *   2. it reused the FORMULA salt, so one secret guarded two unrelated properties and
 *      handing the salt to a formula auditor handed them every nullifier;
 *   3. it produced ONE BabyBear element (~31 bits), which is both brute-forceable and
 *      collision-prone at live volume. See `nullifier-identity.ts` for the measured
 *      numbers — the first collision is at the 62,852nd secret and
 *      `repid_score_events` already holds 152,084 rows.
 *
 * ## Now
 * Per-identity, per-domain, 248-bit, from a DEDICATED master
 * (`REPID_IDENTITY_MASTER_SECRET`) — or, when the caller supplies one, from a
 * holder-derived seed the engine never stores.
 *
 * ## FAILS CLOSED
 * No master and no holder seed ⇒ no statement. Not a fallback to the old derivation:
 * a silently-weaker secret that still produces a plausible-looking nullifier is the
 * exact shape of failure this module is arranged to prevent. The mode gate already
 * defaults `off`, so the only way to reach this is to have deliberately enabled
 * shadow/on, and in that case the operator wants to hear about the missing variable.
 */
function resolveIdentitySecret(input: DeltaBridgeInput, formulaSaltValue: string): IdentitySecret {
  if (input.identitySeedHex) {
    return identitySecretFromHolderSeed({
      seedHex: input.identitySeedHex,
      domain: REPID_DELTA_DOMAIN,
    });
  }
  return deriveIdentitySecret({
    identityId: input.agentId,
    domain: REPID_DELTA_DOMAIN,
    // Key separation is enforced, not documented: if the two secrets are the same
    // string this throws rather than quietly collapsing back to one secret, two jobs.
    formulaSaltForSeparationCheck: formulaSaltValue,
  });
}

/**
 * Build (and optionally record) the statement for one RepID delta.
 *
 * Safe to call unconditionally from the pipeline — it returns immediately when the mode
 * is off.
 */
export async function recordDeltaStatement(input: DeltaBridgeInput): Promise<DeltaBridgeResult> {
  const mode = deltaStatementMode();
  if (mode === 'off') return inert(mode, null);

  const salt = formulaSalt();
  if (!salt) {
    // Loud, once per event, and inert. Silently degrading to an unsalted commitment
    // would publish the formula; silently doing nothing would look like it worked.
    console.warn(
      '[repid-delta-bridge] REPID_DELTA_STATEMENT_MODE is set but ' +
        'REPID_FORMULA_COMMITMENT_SALT is not. No statement built — an unsalted ' +
        'formula commitment is brute-forceable and will not be emitted.',
    );
    return inert(mode, 'no-formula-salt');
  }

  // The identity secret is resolved BEFORE the statement build so a missing master is
  // reported as itself rather than as a generic build failure — an operator who enabled
  // shadow mode and set only one of two variables needs to be told which one.
  if (!input.identitySeedHex && !identityMaster()) {
    console.warn(
      `[repid-delta-bridge] REPID_DELTA_STATEMENT_MODE is set but ${IDENTITY_MASTER_ENV} ` +
        `is not, and no holder seed was supplied. No statement built — deriving the ` +
        `nullifier secret from public inputs is the linkable construction this wire ` +
        `replaced, and falling back to it silently would look like it worked.`,
    );
    return inert(mode, 'no-identity-master');
  }

  let identitySecret: IdentitySecret;
  try {
    identitySecret = resolveIdentitySecret(input, salt);
  } catch (e) {
    // Reached when the master is too short, equals the formula salt, or a holder seed
    // is malformed/too small. All three are configuration errors that must be loud.
    console.error(
      `[repid-delta-bridge] identity secret unavailable: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return inert(mode, 'identity-secret-rejected');
  }

  let built;
  try {
    built = buildRepidDeltaStatement({
      agentId: input.agentId,
      scopeLabel: input.eventLabel,
      witness: {
        hal_score: input.halScore,
        hal_decision: input.halDecision,
        current_repid: input.scoreBefore,
        agent_tier: input.agentTier,
        vesting_cliff_active: input.vestingCliffActive,
        ...(input.taskComplexity !== undefined ? { task_complexity: input.taskComplexity } : {}),
        identitySecret,
      },
      deltaApplied: input.deltaApplied,
      scoreBefore: input.scoreBefore,
      scoreAfter: input.scoreAfter,
    });
  } catch (e) {
    console.error(
      `[repid-delta-bridge] statement build failed for event ${input.eventLabel}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return inert(mode, 'build-threw');
  }

  if (!built.consistent) {
    // THE FINDING THIS WHOLE MODULE EARNS ITS KEEP ON, well before any circuit:
    // a delta on the ledger that the scoring formula would not have produced.
    console.error(
      `[repid-delta-bridge] INCONSISTENT DELTA agent=${input.agentId} ` +
        `event=${input.eventLabel} delta=${input.deltaApplied} — ${built.inconsistency}`,
    );
  }

  if (mode === 'shadow') {
    return {
      mode,
      statement: built.public,
      consistent: built.consistent,
      inconsistency: built.inconsistency,
      persisted: false,
      skipped: null,
      unlinkability: built.unlinkability,
    };
  }

  // mode === 'on'
  try {
    const { error } = await db.from('repid_zkp_proofs').insert({
      agent_id: input.agentId,
      proof_type: 'REPID_DELTA',
      tier_proven: input.agentTier,
      scheme: REPID_DELTA_STATEMENT_SCHEME,
      // NO proof_bytes and is_real=false: there is no proof, only a statement.
      is_real: false,
      zk_commitment: built.public.statement_digest,
      statement: {
        ...built.public,
        consistent: built.consistent,
        inconsistency: built.inconsistency,
        // The honest label travels WITH the row. A downstream reader (a receipt, a
        // dashboard, an outside auditor) must not have to find this file to learn that
        // an engine-derived nullifier is linkable by the master holder.
        unlinkability: built.unlinkability,
        note:
          'STATEMENT ONLY — no ZK proof. This row records the public inputs a Plonky3 ' +
          'circuit must prove; it does not prove them. The nullifier is BOUND to ' +
          'identity_commitment, not PROVEN to be — see the unlinkability field for who ' +
          'can link it.',
      },
    });
    if (error) {
      console.error(`[repid-delta-bridge] insert failed: ${error.message}`);
      return {
        mode,
        statement: built.public,
        consistent: built.consistent,
        inconsistency: built.inconsistency,
        persisted: false,
        skipped: 'insert-error',
        unlinkability: built.unlinkability,
      };
    }
  } catch (e) {
    console.error(
      `[repid-delta-bridge] insert threw: ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      mode,
      statement: built.public,
      consistent: built.consistent,
      inconsistency: built.inconsistency,
      persisted: false,
      skipped: 'insert-threw',
      unlinkability: built.unlinkability,
    };
  }

  return {
    mode,
    statement: built.public,
    consistent: built.consistent,
    inconsistency: built.inconsistency,
    persisted: true,
    skipped: null,
    unlinkability: built.unlinkability,
  };
}

/**
 * Fire-and-forget wrapper for the pipeline.
 *
 * The scoring path must not wait on an audit artefact, and must not be able to fail
 * because of one. Returns void and swallows everything after logging.
 */
export function recordDeltaStatementDetached(input: DeltaBridgeInput): void {
  if (deltaStatementMode() === 'off') return;
  void recordDeltaStatement(input).catch((e) => {
    console.error(
      `[repid-delta-bridge] detached failure: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

export { REPID_DELTA_DOMAIN };
