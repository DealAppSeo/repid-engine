/**
 * Model ids whose vendor has switched them off — the single list, read by BOTH the guard that
 * bans them and the call path that must not dial them (2026-08-28).
 *
 * WHY IT IS ONE LIST AND NOT TWO. `tests/hal-provider-models-not-dead.test.ts` was written
 * because "the repo already KNEW: src/providers/groq.ts documents the shutdown date … the
 * knowledge existed in four files while the live quorum kept calling the dead models anyway,
 * because nothing connected knowing to the call path." A second copy of that knowledge, kept in
 * the test alone, would have recreated exactly that gap one level up: the build would refuse a
 * dead DEFAULT while the runtime happily dialled a dead OVERRIDE. Adding an id here now does
 * both — bans it as a default and makes the quorum skip it — in one edit.
 *
 * EVIDENCE REQUIRED, both directions:
 *   - To ADD an id: the vendor's own error, or ledger rows showing calls that used to succeed
 *     and no longer do. Not a rumour, and not an absence from a docs page.
 *   - To REMOVE one: a successful authenticated call. NOT a docs page — a search today still
 *     reports zai-glm-4.7 as current, which is stale pre-deprecation documentation, and acting
 *     on that kind of source is what put zai-glm-4.6 on this list in the first place.
 *
 * This file is listed in that test's RECORD_NOT_CALL_PATH: it names dead ids as literals by
 * design, which is the one thing the guard otherwise forbids under src/hal.
 */

export interface RetiredModel {
  id: string;
  vendor: string;
  /** When it stopped answering, and how we know. */
  died: string;
}

export const RETIRED_MODELS: ReadonlyArray<RetiredModel> = [
  { id: 'llama-3.1-8b-instant', vendor: 'groq', died: '2026-08-16 (shutdown)' },
  { id: 'llama-3.3-70b-versatile', vendor: 'groq', died: '2026-08-16 (shutdown)' },
  // Ledger: tens of thousands of successes, then a hard stop at 2026-08-17 11:51Z and nothing
  // but model_archived_error after it.
  { id: 'zai-glm-4.7', vendor: 'cerebras', died: '2026-08-17 (archived)' },
  // Chosen as 4.7's replacement FROM DOCUMENTATION, shipped under an explicit NOT_CHECKED
  // caveat, and never once returned a verdict — every call 404s model_not_found. The caveat was
  // right; nothing acted on it for three days.
  { id: 'zai-glm-4.6', vendor: 'cerebras', died: '2026-08-27 (never live on this account)' },
];

const RETIRED_IDS: ReadonlySet<string> = new Set(RETIRED_MODELS.map((m) => m.id));

export function isRetiredModel(id: string): boolean {
  return RETIRED_IDS.has(id);
}

/** The retired ids for one vendor, for error messages that need to say which ones are gone. */
export function retiredModelsFor(vendor: string): RetiredModel[] {
  return RETIRED_MODELS.filter((m) => m.vendor === vendor);
}
