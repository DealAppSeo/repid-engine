// ground-truth-gate — check a claim against Trinity's OWN recorded facts before
// letting an external LLM quorum have the last word on it.
//
// WHY THIS EXISTS. Measured 2026-08-13 against the live evaluator, strictness 2:
//
//   "The Eiffel Tower is located in Paris, France."         true,  public   -> clean   0.000
//   "The Eiffel Tower is located in Berlin, Germany."       false, public   -> vetoed  0.960
//   "HyperDAG x402 mesh settlement uses USDC on Base Sepolia."  TRUE, internal -> VETOED 0.595
//   "RepID attestation v1 uses EIP-712 ... chainId 84532."      TRUE, internal -> flagged 0.405
//
// On public facts the quorum discriminates almost perfectly — a 0.96 spread. On
// true claims about our own systems it collapses into the 0.40–0.60 band, and
// this evaluator's own vetoThreshold (0.5) cuts straight through it. The second
// claim above missed a constitutional block by 0.095.
//
// The cause is not a bad threshold. External model families cannot verify claims
// about a private protocol, and their inability to confirm is being scored as
// FALSE rather than as unknown. No threshold fixes that; the evaluator is asking
// witnesses who were never in the room.
//
// A veto is a constitutional block, so the practical effect is that an agent
// earns nothing for correctly describing the system it works on. RepID gates
// autonomy and receipts come from scored events, so internal-domain work could
// never accumulate standing.
//
// WHAT THIS DOES. `public.ground_truth_facts` already holds 144 curated rows —
// 35 of them about HyperDAG/RepID/Trinity internals — and, before this file,
// **nothing in the codebase read it**. The identifier appeared only in generated
// database.types.ts. This module makes that table an authority on our own facts.
//
// It is deliberately TWO-SIDED, which is what keeps it from being a whitelist:
//
//   match_type 'exact' / 'contains'  → the recorded CORRECT value. A hit
//                                      corroborates the claim.
//   match_type 'wrong_value'         → a recorded KNOWN-WRONG value ("Ethereum
//                                      mainnet", "2019"). A hit refutes it.
//
// So the corpus can veto as well as clear, and it catches internal falsehoods
// the external quorum has no way to detect. Contradiction always beats
// corroboration.
//
// SAFETY PROPERTIES, each of which exists because its absence is a real failure:
//
//   1. Contradiction wins. Text containing both a right and a wrong value is
//      refuted, never cleared.
//   2. Only DISTINCTIVE values are matched. "2016" appearing anywhere must not
//      corroborate a claim about a start year; see isDistinctive().
//   3. Word-boundary matching, so "84532" does not match inside "184532".
//   4. A lookup failure degrades to 'no_match' and the quorum decision stands
//      unchanged. This gate can never turn a database outage into a verdict.
//   5. It never invents a decision — it only reports what the corpus says. The
//      caller decides what to do with that.
//   6. The lookup is HARD-BOUNDED by a timeout and cached per process. This sits
//      in front of every fact-check; an unbounded await here adds database
//      latency to every scored claim, and a stalled connection hangs the
//      evaluator outright. Found in CI on this file's first run: tests/hal/
//      fact-check.test.ts carries no db mock, because factCheck was a pure
//      function over mocked providers until this gate gave it a real dependency,
//      and the query timed the suite out.

import { db } from '../db';

/**
 * Bound on the corpus read. Deliberately short: this runs before every verdict.
 * Read per call rather than captured at import so an operator (or a test) can
 * change it without reloading the module.
 */
const lookupTimeoutMs = () => Number(process.env.HAL_GROUND_TRUTH_TIMEOUT_MS ?? 1500);
/** 144 static rows that change rarely — re-reading them per claim is pure waste. */
const cacheTtlMs = () => Number(process.env.HAL_GROUND_TRUTH_TTL_MS ?? 300_000);

export type GroundTruthVerdict = 'corroborated' | 'contradicted' | 'no_match';

export interface GroundTruthHit {
  fact_key: string;
  fact_value: string;
  category: string;
  match_type: string;
}

export interface GroundTruthResult {
  verdict: GroundTruthVerdict;
  /** Facts whose recorded CORRECT value appears in the claim. */
  corroborating: GroundTruthHit[];
  /** Facts whose recorded KNOWN-WRONG value appears in the claim. */
  contradicting: GroundTruthHit[];
  /** Human-readable, and safe to surface in an API response. */
  reason: string;
  /** True when the corpus could not be consulted. Never inferred as agreement. */
  degraded: boolean;
}

const EMPTY = (reason: string, degraded = false): GroundTruthResult => ({
  verdict: 'no_match',
  corroborating: [],
  contradicting: [],
  reason,
  degraded,
});

/**
 * Is this fact value specific enough that finding it in a sentence means
 * something?
 *
 * This predicate is the whole safety margin on the corroboration side. The
 * corpus contains values like "2016" (HyperDAG start year) which appear in
 * unrelated text constantly; treating those as corroboration would let any
 * sentence containing a common number clear the quorum.
 *
 * Distinctive:   "Base Sepolia" (multi-word), "84532" (5+ digits),
 *                "0x8004A818…" (long), "@hyperdag/trustshell" (long)
 * NOT:           "2016", "12", "v1"
 */
export function isDistinctive(value: string): boolean {
  const v = value.trim();
  if (v.length < 4) return false;
  if (/\s/.test(v)) return true;              // multi-word proper nouns
  if (/^\d+$/.test(v)) return v.length >= 5;  // bare numbers need real length
  return v.length >= 6;
}

/** Word-boundary containment, case-insensitive, regex-safe. */
export function containsValue(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b is unreliable next to punctuation like '@' or '0x', so bound on
  // non-alphanumeric instead of relying on word characters.
  return new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(haystack);
}

interface FactRow {
  fact_key: string;
  fact_value: string | null;
  category: string | null;
  match_type: string | null;
}

let cachedRows: FactRow[] | null = null;
let cachedAt = 0;

/** Test seam — drop the process cache so a test can vary the corpus. */
export function __resetGroundTruthCache(): void {
  cachedRows = null;
  cachedAt = 0;
}

/**
 * Read the corpus, bounded and cached.
 *
 * Returns null on timeout/error/empty — every one of which the caller must treat
 * as "the corpus said nothing", never as agreement. Only a successful non-empty
 * read is cached; a failure is retried on the next claim, with the timeout
 * bounding what that retry can cost.
 */
async function loadCorpus(): Promise<{ rows: FactRow[] | null; why: string }> {
  const now = Date.now();
  if (cachedRows && now - cachedAt < cacheTtlMs()) {
    return { rows: cachedRows, why: 'cache' };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = (async () => {
      const { data, error } = await db
        .from('ground_truth_facts')
        .select('fact_key, fact_value, category, match_type');
      if (error) throw new Error(error.message);
      return (data ?? []) as FactRow[];
    })();

    const timeout = new Promise<never>((_, reject) => {
      const ms = lookupTimeoutMs();
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });

    const rows = await Promise.race([query, timeout]);
    if (rows.length === 0) return { rows: null, why: 'ground_truth_facts is empty' };

    cachedRows = rows;
    cachedAt = now;
    return { rows, why: 'fresh' };
  } catch (e: any) {
    return { rows: null, why: `ground_truth_facts unavailable: ${e?.message ?? String(e)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Consult the corpus about one claim.
 *
 * Never throws. A failure to read the table is reported as `degraded: true` with
 * verdict 'no_match', which callers must treat as "the corpus said nothing" —
 * not as "the corpus agreed".
 */
export async function checkGroundTruth(text: string): Promise<GroundTruthResult> {
  if (!text || !text.trim()) return EMPTY('empty claim text');

  const { rows, why } = await loadCorpus();
  if (!rows) return EMPTY(why, true);

  const corroborating: GroundTruthHit[] = [];
  const contradicting: GroundTruthHit[] = [];

  for (const r of rows) {
    const value = (r.fact_value ?? '').trim();
    if (!value || !isDistinctive(value)) continue;
    if (!containsValue(text, value)) continue;

    const hit: GroundTruthHit = {
      fact_key: r.fact_key,
      fact_value: value,
      category: r.category ?? 'uncategorised',
      match_type: r.match_type ?? 'exact',
    };

    if (r.match_type === 'wrong_value') contradicting.push(hit);
    else corroborating.push(hit);
  }

  // Contradiction beats corroboration, always. A claim that states the right
  // chain and the wrong start year is still wrong.
  if (contradicting.length > 0) {
    return {
      verdict: 'contradicted',
      corroborating,
      contradicting,
      reason:
        `Trinity's own ground-truth corpus records ${contradicting.length} known-wrong ` +
        `value(s) in this claim: ${contradicting.map((h) => `${h.fact_key}="${h.fact_value}"`).join(', ')}.`,
      degraded: false,
    };
  }

  if (corroborating.length > 0) {
    return {
      verdict: 'corroborated',
      corroborating,
      contradicting,
      reason:
        `Trinity's own ground-truth corpus confirms ${corroborating.length} value(s) in this claim: ` +
        `${corroborating.map((h) => `${h.fact_key}="${h.fact_value}"`).join(', ')}. ` +
        `An external quorum cannot verify claims about a private system; this corpus can.`,
      degraded: false,
    };
  }

  return EMPTY('no distinctive ground-truth value found in this claim');
}
