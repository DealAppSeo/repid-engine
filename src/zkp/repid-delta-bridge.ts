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
}

const inert = (mode: DeltaStatementMode, skipped: string | null): DeltaBridgeResult => ({
  mode,
  statement: null,
  consistent: null,
  inconsistency: null,
  persisted: false,
  skipped,
});

/**
 * Derive the per-event nullifier secret.
 *
 * ⚠ THIS IS THE WEAKEST PART OF THE CURRENT WIRE AND IS DELIBERATELY NOT PRETENDING
 * OTHERWISE. A nullifier is only unlinkable if its secret is unpredictable. Here the
 * secret is derived from the salt and the event label, which means anyone holding the
 * salt can recompute it. That is adequate for its ONE current job — detecting that the
 * same event was recorded twice — and it is NOT adequate for hiding which agent a
 * nullifier belongs to.
 *
 * A real per-agent identity secret (the `human_sbt_mints.commitment_hash` line from
 * ZKP invariant 2) is what makes this unlinkable, and that binding is a separate beat.
 * Until then: treat the nullifier as a de-duplication tag, not as a privacy guarantee,
 * and do not publish a claim that it is one.
 */
function eventSecret(salt: string, eventLabel: string): bigint {
  let h = 0n;
  const src = `${salt}|${eventLabel}`;
  for (let i = 0; i < src.length; i++) {
    h = (h * 131n + BigInt(src.charCodeAt(i))) % 2013265921n;
  }
  // Never 0: a zero secret makes the nullifier a function of the scope alone.
  return h === 0n ? 1n : h;
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
        eventSecret: eventSecret(salt, input.eventLabel),
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
        note:
          'STATEMENT ONLY — no ZK proof. This row records the public inputs a Plonky3 ' +
          'circuit must prove; it does not prove them.',
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
    };
  }

  return {
    mode,
    statement: built.public,
    consistent: built.consistent,
    inconsistency: built.inconsistency,
    persisted: true,
    skipped: null,
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
