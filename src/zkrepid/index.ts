/**
 * zkRepID — the canonical entry point for proving a RepID without revealing it.
 *
 * DECIDED 2026-08-17 (Sean): zkRepID is the canonical name for this layer.
 * Boundary and rationale: ./boundary.ts. Prose: docs/ZKREPID.md. Decision: DECISIONS.md §9.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ════════════════════════════════════════════════════════════════════════════════
 * A re-export barrel over the RepID-specific modules that already live in `src/zkp/`. It is
 * PURELY ADDITIVE: no existing file moved, no import changed, no behaviour altered. The modules
 * beneath remain importable by their own paths and every existing consumer is untouched.
 *
 * Its job is to make the name name something. `docs/RSI-ADOPTION-PLAN.md` §0 recorded that
 * `zkRepID` appeared in no code in any of the four repos, and that adopting a term which names
 * nothing is the failure LESSONS §5 describes. This file is the answer to that: after it,
 * `zkRepID` resolves to an importable surface with a machine-checked boundary, rather than to a
 * word used in documents.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NAMESPACED, NOT FLATTENED — AND NOT BY PREFERENCE
 * ════════════════════════════════════════════════════════════════════════════════
 * `export *` would not compile here: `feltsFromString` is exported by BOTH
 * `repid-delta-statement` and `nullifier-identity`, with different domain separation tags. A flat
 * barrel would either fail to build or silently resolve one of them, and "silently resolve one of
 * them" applied to a domain-separation helper is how two proofs end up committing to the same
 * digest under different intents.
 *
 * Namespaces keep each module's identity visible at the call site — `statement.feltsFromString`
 * and `nullifier.feltsFromString` cannot be confused for one another.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * IMPORTS WITH NO ENVIRONMENT SET — A PROPERTY, NOT AN ACCIDENT
 * ════════════════════════════════════════════════════════════════════════════════
 * Everything re-exported below is pure: importing this file reads no environment, opens no
 * connection, and constructs no client. `tests/zkrepid-boundary.test.ts` enforces that by
 * clearing the Supabase variables and importing the barrel.
 *
 * `repid-delta-bridge` is deliberately ABSENT even though it IS zkRepID. It imports `../db`, and
 * `src/config.ts` throws at module scope without credentials — so re-exporting it would make this
 * barrel throw for every consumer, including ones that only wanted a domain constant. A canonical
 * entry point that is harder to import than the modules under it does not get used, and a name
 * nobody imports is back to naming nothing. Import the bridge directly, and knowingly:
 *
 *     import { recordDeltaStatement } from '../zkp/repid-delta-bridge';
 */

/** The public statement a RepID delta proof commits to. */
export * as statement from '../zkp/repid-delta-statement';

/** Batching RepID delta statements into an anchorable Merkle root. */
export * as anchor from '../zkp/delta-anchor';

/** The join between a RepID proof and an on-chain ERC-8004 identity. */
export * as erc8004 from '../zkp/erc8004-linkage';

/** Binding a RepID proof to the holder who earned it. */
export * as holder from '../zkp/holder-identity-binding';

/** Per-identity nullifiers, so one RepID cannot be replayed as many. */
export * as nullifier from '../zkp/nullifier-identity';

/**
 * The selective-disclosure seam: prove `repid >= threshold` without publishing the score.
 *
 * SHADOW MODE BY DEFAULT, and it refuses to enforce. Read the module header before wiring it to
 * anything that grants access — `provenWithoutSecret` is structurally false until a circuit exists,
 * and `ZKREPID_DISCLOSURE_MODE=enforce` throws rather than let an unproven statement gate.
 */
export * as disclosure from './disclosure';

/**
 * The formula's observable behaviour, pinned per version.
 *
 * Not a proving primitive — it is the other end of the wire from `statement.formulaCommitment`. A
 * version string behind a salted hash that no test reads cannot detect a behaviour change; this
 * module is what makes the version mean something. See docs/FORMULA-VERSIONING.md.
 */
export * as formulaVector from '../zkp/formula-golden-vector';

/** The boundary itself — what zkRepID covers, what it does not, and why. */
export {
  ZKREPID_MODULES,
  ZKREPID_PURE_MODULES,
  ZKREPID_IO_EDGE_MODULES,
  NOT_ZKREPID,
} from './boundary';
export type { ZkRepIdModule } from './boundary';
