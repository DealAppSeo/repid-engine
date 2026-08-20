/**
 * Caveats: the limits attached to a grant that capabilities alone cannot express.
 *
 * PORTED, not re-derived, from trinity-ecosystem's `lib/trustshell/identity/caveat.ts` (same
 * fail-closed reasoning applies here as in `principal-capability.ts` — see that file's header
 * for why this is a copy rather than a cross-repo import).
 *
 * `pay:usdc` says which door is open; `maxValue 100 USDC` says how far through it the holder
 * may walk.
 *
 * AN UNENFORCED CAVEAT IS WORSE THAN NO CAVEAT. A caveat sitting in a signed grant reads as a
 * control: an operator seeing `maxCalls: 5` reasonably concludes the sixth call is refused. If
 * nothing counts calls, that conclusion is false and the grant is actively misleading — worse
 * than a grant that never claimed the limit. So caveats are split by what enforcement actually
 * requires:
 *
 *   STATELESS — decidable from the request in front of you. `maxValue`, `toolAllowlist`.
 *               Enforced today, and returning VERIFIED means it really was checked.
 *   STATEFUL  — needs memory across requests. `maxCalls` cannot be decided from one request, so
 *               without a counter store it reports NOT_CHECKED with the reason. It never
 *               silently passes.
 *
 * CAVEATS ATTENUATE. A child may tighten a parent's limit and never loosen it. A delegate
 * holding `maxValue 100` cannot mint a sub-delegate with `maxValue 1000`, and — the case that
 * is easy to miss — cannot mint one with NO maxValue at all. Dropping a caveat is loosening it.
 */

export type Caveat =
  | { type: 'maxValue'; asset: string; amount: number }
  | { type: 'toolAllowlist'; tools: string[] }
  | { type: 'maxCalls'; limit: number };

export type CaveatOutcome = 'VERIFIED' | 'NOT_CHECKED' | 'FAILED';

export interface CaveatResult {
  caveat: Caveat;
  outcome: CaveatOutcome;
  detail: string;
}

/** What the verifier knows about the action being authorized. */
export interface ActionContext {
  /** For `maxValue`. Omitted when the action moves no value. */
  value?: { asset: string; amount: number };
  /** For `toolAllowlist`. The tool the agent intends to invoke. */
  tool?: string;
  /**
   * For `maxCalls`. Supplied only by a caller that actually counts. Absent means the caveat
   * reports NOT_CHECKED rather than passing.
   */
  callsSoFar?: number;
}

/** Canonical encoding, so the bytes signed are the bytes reconstructed. */
export function encodeCaveats(caveats: Caveat[]): string {
  return [...caveats].map(encodeOne).sort().join(',');
}

function encodeOne(c: Caveat): string {
  switch (c.type) {
    case 'maxValue':
      return `maxValue:${c.asset}:${c.amount}`;
    case 'toolAllowlist':
      return `toolAllowlist:${[...c.tools].sort().join('+')}`;
    case 'maxCalls':
      return `maxCalls:${c.limit}`;
  }
}

/**
 * Evaluate every caveat against a proposed action.
 *
 * Returns one result per caveat rather than a single boolean: a caller needs to know WHICH
 * limit stopped it, and — more importantly — which limits were not checked at all.
 */
export function evaluateCaveats(caveats: Caveat[], ctx: ActionContext): CaveatResult[] {
  return caveats.map((caveat) => {
    switch (caveat.type) {
      case 'maxValue': {
        if (!ctx.value) {
          return {
            caveat,
            outcome: 'NOT_CHECKED',
            detail:
              'no value supplied in the action context, so the cap was not applied. If this ' +
              'action moves value, the caller failed to declare it.',
          };
        }
        if (ctx.value.asset !== caveat.asset) {
          // A cap on USDC says nothing about a transfer of USDT. Passing here would let a
          // holder route around the cap by switching asset.
          return {
            caveat,
            outcome: 'FAILED',
            detail: `cap is denominated in ${caveat.asset} but the action moves ${ctx.value.asset}; refusing rather than treating the cap as inapplicable`,
          };
        }
        return ctx.value.amount <= caveat.amount
          ? { caveat, outcome: 'VERIFIED', detail: `${ctx.value.amount} <= ${caveat.amount} ${caveat.asset}` }
          : { caveat, outcome: 'FAILED', detail: `${ctx.value.amount} exceeds ${caveat.amount} ${caveat.asset}` };
      }

      case 'toolAllowlist': {
        if (ctx.tool === undefined) {
          return {
            caveat,
            outcome: 'NOT_CHECKED',
            detail: 'no tool declared in the action context, so the allowlist was not applied',
          };
        }
        return caveat.tools.includes(ctx.tool)
          ? { caveat, outcome: 'VERIFIED', detail: `'${ctx.tool}' is allowlisted` }
          : { caveat, outcome: 'FAILED', detail: `'${ctx.tool}' is not in [${caveat.tools.join(', ')}]` };
      }

      case 'maxCalls': {
        // Stateful. Undecidable from one request.
        if (ctx.callsSoFar === undefined) {
          return {
            caveat,
            outcome: 'NOT_CHECKED',
            detail:
              'maxCalls needs a counter the verifier keeps across requests, and none was ' +
              'supplied. Reported rather than passed: a limit nobody counts is not a limit, ' +
              'and silently honouring it would make the grant misleading.',
          };
        }
        return ctx.callsSoFar < caveat.limit
          ? { caveat, outcome: 'VERIFIED', detail: `${ctx.callsSoFar} of ${caveat.limit} used` }
          : { caveat, outcome: 'FAILED', detail: `limit of ${caveat.limit} reached (${ctx.callsSoFar} used)` };
      }
    }
  });
}

/** True when no caveat FAILED. NOT_CHECKED does not fail an action, but is reported. */
export function caveatsPermit(results: CaveatResult[]): boolean {
  return !results.some((r) => r.outcome === 'FAILED');
}

/**
 * May `child` be delegated by a holder of `parent`?
 *
 * Tightening is allowed, loosening is not, and DROPPING a caveat counts as loosening — the
 * case most likely to be missed, because an absent caveat looks like "nothing to check" rather
 * than "the limit was removed".
 */
export function isCaveatAttenuationOf(child: Caveat[], parent: Caveat[]): boolean {
  for (const p of parent) {
    const c = child.find((x) => sameKind(x, p));
    // Dropped entirely — the child would be unconstrained where its parent was not.
    if (!c) return false;
    if (!tightensOrEquals(c, p)) return false;
  }
  // A child MAY add caveats the parent did not have: that is further narrowing.
  return true;
}

function sameKind(a: Caveat, b: Caveat): boolean {
  if (a.type !== b.type) return false;
  // Two maxValue caveats in different assets are different constraints, not competing
  // versions of one.
  if (a.type === 'maxValue' && b.type === 'maxValue') return a.asset === b.asset;
  return true;
}

function tightensOrEquals(child: Caveat, parent: Caveat): boolean {
  if (child.type === 'maxValue' && parent.type === 'maxValue') {
    return child.asset === parent.asset && child.amount <= parent.amount;
  }
  if (child.type === 'maxCalls' && parent.type === 'maxCalls') {
    return child.limit <= parent.limit;
  }
  if (child.type === 'toolAllowlist' && parent.type === 'toolAllowlist') {
    return child.tools.every((t) => parent.tools.includes(t));
  }
  return false;
}

/** Caveats in `child` that loosen or drop one in `parent`. Empty means legal. */
export function caveatViolations(child: Caveat[], parent: Caveat[]): string[] {
  const out: string[] = [];
  for (const p of parent) {
    const c = child.find((x) => sameKind(x, p));
    if (!c) {
      out.push(`drops ${encodeOne(p)} — an absent caveat is an unconstrained one`);
      continue;
    }
    if (!tightensOrEquals(c, p)) out.push(`loosens ${encodeOne(p)} to ${encodeOne(c)}`);
  }
  return out;
}
