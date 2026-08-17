/**
 * module-space.ts — one boundary, several implementations, exactly one of which has authority.
 *
 * TERMINOLOGY: "Module Space" is borrowed from the OmegaClaw/OmegaHive design papers
 * (Goertzel, *Seeding RSI Toward ASI*, 2026-08-07). See docs/RSI-ADOPTION-PLAN.md §3.3
 * for what we took, what we declined, and why the term was adopted verbatim rather than
 * renamed: it names a boundary we already had in fact and not in code.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE BOUNDARY THAT ALREADY EXISTS IN FACT
 * ════════════════════════════════════════════════════════════════════════════════
 * HAL has two signal extractors that disagree, and the disagreement is documented in
 * docs/HAL_CANONICAL_v1.md: path A (`extractHALSignals`) returns QUALITY on evidence and
 * scope, path B (the certainty-only extractor inlined in the live scoring route) returns
 * RISK on the same two axes, so one is inverted before weighting and the other is not.
 * Two implementations of one contract, chosen by which route you entered through, with
 * nothing naming the contract they are both implementing.
 *
 * That is a Module Space whether or not anyone declares it. This module is the declaration.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE ONE PROPERTY THIS MODULE EXISTS TO GUARANTEE
 * ════════════════════════════════════════════════════════════════════════════════
 * A shadow implementation CANNOT change what the caller receives.
 *
 * Not "should not" — cannot, structurally. `runWithShadows` returns the incumbent's output
 * and there is no code path by which a shadow's return value reaches the result. A shadow
 * that throws is recorded as having thrown and is otherwise ignored, the same way
 * `checkAndAwardBadges` is non-blocking so badges can never break scoring.
 *
 * WHY THAT IS THE PROPERTY. `CONSTITUTIONAL_AUDIT_ENABLED` has been false since 2026-07-05
 * and the callers are individually responsible for routing around the stub's output while it
 * is off. That is a convention held by every call site, and LESSONS §3 is about what happens
 * to conventions like it. Here the guarantee lives at the boundary instead: a caller cannot
 * accidentally consume shadow output, because the function never returns any.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE DELIBERATELY IS NOT
 * ════════════════════════════════════════════════════════════════════════════════
 * It is not a router. `src/providers/router.ts`, `src/services/anfis-router.ts` and
 * `src/zkp/proof-router.ts` each pick a destination by policy; this picks nothing. It runs the
 * one implementation that already holds authority, and observes the others. The plan (§7)
 * is explicit that this must not become a router refactor — CLAUDE-RULE-3.
 *
 * It also does not GRANT authority. `authority` here is a declared fact about an
 * implementation; the question of whether a shadow has EARNED promotion belongs to
 * ./promotion-ledger, which is the only place a state change is allowed to be justified.
 *
 * PURITY: no I/O, no env reads, no DB, no clock. `runWithShadows` takes an explicit `now`
 * for its observation timestamps so its output is a function of its arguments.
 */

/**
 * What an implementation is allowed to do at this boundary.
 *
 * - `incumbent` — holds authority. Its output IS the boundary's output. Exactly one per space.
 * - `shadow`    — runs for observation only. Structurally cannot influence the output.
 * - `retired`   — does not run at all. Kept so a space's history stays readable and so a
 *                 rejected candidate cannot be quietly deleted and re-proposed as novel.
 */
export type Authority = 'incumbent' | 'shadow' | 'retired';

/** One implementation sitting behind the boundary. */
export interface ModuleImplementation<I, O> {
  /** Unique within its space. Appears in ledger entries, so it must be stable. */
  readonly id: string;
  readonly authority: Authority;
  /** May be sync or async; `runWithShadows` awaits either. */
  run(input: I): Promise<O> | O;
}

/** A named boundary and everything sitting behind it. */
export interface ModuleSpace<I, O> {
  /** Stable id. This is what a promotion-ledger entry points at. */
  readonly id: string;
  /** What the boundary is for, in one line. */
  readonly description: string;
  readonly implementations: readonly ModuleImplementation<I, O>[];
}

/** A structural problem with a space. `severity` decides whether it is fatal. */
export interface ModuleSpaceFault {
  code:
    | 'NO_IMPLEMENTATIONS'
    | 'NO_INCUMBENT'
    | 'MULTIPLE_INCUMBENTS'
    | 'DUPLICATE_ID'
    | 'EMPTY_ID'
    | 'SINGLE_IMPLEMENTATION';
  message: string;
  /** `error` — the space is unusable. `flag` — usable, but something is worth saying out loud. */
  severity: 'error' | 'flag';
}

/**
 * Every structural problem with a space, worst first.
 *
 * SINGLE_IMPLEMENTATION is a FLAG, not an error, and the distinction is the point.
 * A space legitimately starts with only its incumbent — that is what declaring an existing
 * boundary looks like on day one. But docs/RSI-ADOPTION-PLAN.md §6 lists "a Module Space with
 * one implementation behind it" as something that would NOT count as progress, because a
 * boundary with nothing to compare against buys nothing but indirection. So it is said out
 * loud, every time, rather than discovered later.
 *
 * This mirrors src/hal/checkpoint-registry.ts, where an unmapped model is a loud flag that can
 * only ever REDUCE claimed independence and never fake it.
 */
export function moduleSpaceFaults<I, O>(space: ModuleSpace<I, O>): ModuleSpaceFault[] {
  const faults: ModuleSpaceFault[] = [];
  const impls = space.implementations;

  if (impls.length === 0) {
    faults.push({
      code: 'NO_IMPLEMENTATIONS',
      message: `module space '${space.id}' has no implementations`,
      severity: 'error',
    });
    return faults;
  }

  const seen = new Set<string>();
  for (const impl of impls) {
    if (impl.id.trim() === '') {
      faults.push({
        code: 'EMPTY_ID',
        message: `module space '${space.id}' has an implementation with an empty id`,
        severity: 'error',
      });
      continue;
    }
    if (seen.has(impl.id)) {
      faults.push({
        code: 'DUPLICATE_ID',
        message: `module space '${space.id}' has two implementations with id '${impl.id}'`,
        severity: 'error',
      });
    }
    seen.add(impl.id);
  }

  const incumbents = impls.filter((i) => i.authority === 'incumbent');
  if (incumbents.length === 0) {
    faults.push({
      code: 'NO_INCUMBENT',
      message: `module space '${space.id}' has no incumbent; nothing holds authority at this boundary`,
      severity: 'error',
    });
  } else if (incumbents.length > 1) {
    faults.push({
      code: 'MULTIPLE_INCUMBENTS',
      message:
        `module space '${space.id}' has ${incumbents.length} incumbents ` +
        `(${incumbents.map((i) => i.id).join(', ')}); exactly one implementation may hold authority`,
      severity: 'error',
    });
  }

  const running = impls.filter((i) => i.authority !== 'retired');
  if (running.length === 1) {
    faults.push({
      code: 'SINGLE_IMPLEMENTATION',
      message:
        `module space '${space.id}' has one running implementation, so nothing is being compared. ` +
        `A boundary with no candidate behind it buys indirection and no measurement.`,
      severity: 'flag',
    });
  }

  return faults;
}

/** Construct a space, refusing any structural error. Flags are returned by `moduleSpaceFaults`, not thrown. */
export function defineModuleSpace<I, O>(space: ModuleSpace<I, O>): ModuleSpace<I, O> {
  const errors = moduleSpaceFaults(space).filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `[module-space] refusing to define '${space.id}': ${errors.map((e) => e.message).join('; ')}`,
    );
  }
  return space;
}

/** The implementation holding authority. Throws if the space has no incumbent. */
export function incumbentOf<I, O>(space: ModuleSpace<I, O>): ModuleImplementation<I, O> {
  const found = space.implementations.find((i) => i.authority === 'incumbent');
  if (!found) {
    throw new Error(`[module-space] '${space.id}' has no incumbent`);
  }
  return found;
}

/** Every implementation running for observation only. */
export function shadowsOf<I, O>(space: ModuleSpace<I, O>): ModuleImplementation<I, O>[] {
  return space.implementations.filter((i) => i.authority === 'shadow');
}

/**
 * What a shadow did. Three outcomes, never two — a shadow that was not run is not a shadow
 * that agreed. `ok: false` carries the error message; `agreed` is left to the caller because
 * only the caller knows what equality means for `O`.
 */
export type ShadowObservation<O> =
  | { implementationId: string; ok: true; output: O; elapsedMs: number }
  | { implementationId: string; ok: false; error: string; elapsedMs: number };

/** The incumbent's output, plus what the shadows did while it was produced. */
export interface ModuleSpaceRun<O> {
  spaceId: string;
  /** THE result. Always the incumbent's. No shadow contributes to this value. */
  output: O;
  incumbentId: string;
  shadows: ShadowObservation<O>[];
  at: string;
}

/**
 * Run the boundary: incumbent for the answer, shadows for the record.
 *
 * Ordering is deliberate. The incumbent runs FIRST and its output is captured before any
 * shadow is invoked, so a shadow cannot observe or mutate the incumbent's result even through
 * shared state it was handed. If the incumbent throws, the error propagates and NO shadow runs
 * — a failed boundary must not be silently answered by an implementation that lacks authority.
 *
 * Shadows are run sequentially rather than concurrently: they exist to be measured, and
 * concurrent execution would make the per-shadow `elapsedMs` a measurement of contention
 * rather than of the shadow (LESSONS §8 — a measurement without its ruler is not a result).
 *
 * `now` is injected so this function stays pure.
 */
export async function runWithShadows<I, O>(
  space: ModuleSpace<I, O>,
  input: I,
  now: () => number,
): Promise<ModuleSpaceRun<O>> {
  const incumbent = incumbentOf(space);
  const startedAt = now();

  // The authoritative call. Anything it throws is the caller's problem, not a shadow's chance.
  const output = await incumbent.run(input);

  const shadows: ShadowObservation<O>[] = [];
  for (const shadow of shadowsOf(space)) {
    const t0 = now();
    try {
      const shadowOutput = await shadow.run(input);
      shadows.push({
        implementationId: shadow.id,
        ok: true,
        output: shadowOutput,
        elapsedMs: now() - t0,
      });
    } catch (err) {
      // Swallowed on purpose. A shadow holds no authority, so it cannot fail the boundary.
      shadows.push({
        implementationId: shadow.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: now() - t0,
      });
    }
  }

  return {
    spaceId: space.id,
    output, // captured before any shadow ran
    incumbentId: incumbent.id,
    shadows,
    at: new Date(startedAt).toISOString(),
  };
}
