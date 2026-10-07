/**
 * NAMED ROLES for principal-to-principal grants — CEO / CTO / CFO / CMO.
 *
 * A role is a CEILING, never a grant. Naming `cfo` on a mint does not hand anyone spend
 * authority; it states the MOST that grant may carry. The effective capability set is the
 * intersection of three things, and a role can only ever shrink it:
 *
 *     effective = requested  ∩  what the grantor actually holds  ∩  the role's ceiling
 *
 * WHY A CEILING AND NOT A TEMPLATE. A template hands out capabilities, which makes the role a
 * privilege source — exactly the escalation primitive `principal-capability.ts`'s own header
 * warns about ("a grantor holding only `pay:usdc` that could mint `pay:*` is a
 * privilege-escalation primitive wearing a delegation costume"). A ceiling cannot escalate by
 * construction: it appears only on the narrowing side of an intersection.
 *
 * THE FIELD THIS REPLACES WAS A LABEL THAT LOOKED LIKE A CONTROL. `principal_grants.role` is
 * `string | null` today — stored, returned to callers, consulted by nothing. That is the shape
 * this codebase found four times in one day (a builder floor reporting PASSED without running,
 * an ecosystem-need multiplier persisted but never applied, a flag documented as containing
 * keyless builders that enforces nothing, a display figure no gate would honour). Adding role
 * NAMES without role CONSEQUENCES would have been the fifth.
 *
 * So this module reports three states, never two:
 *
 *   RECOGNIZED   a known role. Its ceiling is applied and the mint is narrowed or refused.
 *   LABEL_ONLY   free text. Stored for humans, CONSTRAINS NOTHING, and says so out loud —
 *                because silently treating an unknown string as a constraint, or as
 *                permission, are both worse than admitting it decorates.
 *   ABSENT       no role given. Unchanged behaviour.
 *
 * LABEL_ONLY exists for backward compatibility: grants already carry free-text roles like
 * "Researcher / Data". Rejecting those outright would break live rows to no benefit. What must
 * never happen is a caller reading an unrecognised string as though it bounded anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE CEILINGS ARE WRITTEN OVER THE NAMESPACE THAT ACTUALLY EXISTS.
 *
 * Measured 2026-08-29: the live capability vocabulary in this codebase is essentially
 * `pay:usdc`, `pay:usdt`, `pay:eth` and `pay:*`. There is no enforcement anywhere for
 * `deploy:*`, `publish:*`, `hire:*` or any of the other verbs a C-suite metaphor invites.
 *
 * Inventing those would produce ceilings that constrain nothing — a role layer that reads as
 * governance and enforces air. So the ceilings below are deliberately narrow, and the most
 * useful thing they say today is a NEGATIVE one:
 *
 *     A CTO or CMO grant CANNOT CARRY SPEND AUTHORITY. AT ALL.
 *
 * That is enforceable right now, against the real namespace, and it is the constraint most
 * worth having: the agent writing your code cannot move your money, whatever it asks for and
 * whatever its grantor holds.
 *
 * ONE ADDITION, 2026-10-07: `read:tool:*`, the tool belts. A belt grant names each read-only tool
 * an agent may use for its role, as `read:tool:<id>` (the ids live in trustshell's
 * `lib/belts.ts`, where every tool says how it is kept to reads). Every role may carry it, because
 * reading is not spending: CTO and CMO still hold no `pay:` capability at any denomination.
 *
 * What answers for it, and what does not yet: `POST /grants/:id/authorize` returns a real
 * decision for a `read:tool:<id>` capability (capability, chain liveness, expiry, revocation).
 * Nothing calls it before a tool runs yet — the client that does is the next build. Until then a
 * belt grant is a record a caller CAN check, and the UI that mints one has to say so.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

import { permits, intersect } from './principal-capability';

/** The roles that carry a ceiling. Anything else is LABEL_ONLY. */
export const ROLE_NAMES = ['ceo', 'cto', 'cfo', 'cmo'] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export interface RoleDefinition {
  name: RoleName;
  /** Human-facing name. Display only — never matched against. */
  label: string;
  /**
   * The MOST this role may ever hold. An empty array would mean "this role may hold nothing".
   * Every entry must be a capability the algebra can match segment-wise.
   */
  ceiling: readonly string[];
  /** Why this ceiling, in one line, so a reader can disagree with the reasoning and not just the list. */
  rationale: string;
}

/**
 * PAI-as-CEO is deliberately NOT `*`.
 *
 * A root capability held by a running agent is the thing the whole attenuation algebra exists
 * to prevent. The CEO ceiling is broad on money because delegating budget is the CEO's actual
 * job in this system; it is not unbounded, so a future capability verb is not silently
 * pre-authorised for it the day someone adds one.
 */
const DEFINITIONS: Readonly<Record<RoleName, RoleDefinition>> = {
  ceo: {
    name: 'ceo',
    label: 'PAI (CEO)',
    ceiling: ['pay:*', 'read:tool:*'],
    rationale:
      'delegating budget is this role\'s actual function; bounded to pay and read-only tools so a ' +
      'capability verb added later is not retroactively pre-authorised',
  },
  cfo: {
    name: 'cfo',
    label: 'CFO',
    ceiling: ['pay:*', 'read:tool:*'],
    rationale: 'the money role; same spend ceiling as CEO, distinguished by who may mint it, plus read-only tools',
  },
  cto: {
    name: 'cto',
    label: 'CTO',
    ceiling: ['read:tool:*'],
    rationale:
      'NO SPEND, EVER. The engineering role holds no pay capability at any denomination — the ' +
      'agent writing the code cannot move the money, whatever it asks for or its grantor holds. ' +
      'It may carry read-only tools',
  },
  cmo: {
    name: 'cmo',
    label: 'CMO',
    ceiling: ['read:tool:*'],
    rationale:
      'NO SPEND, EVER. Same reasoning as CTO: publishing authority is not spending authority. ' +
      'It may carry read-only tools',
  },
};

export type RoleResolution =
  | { status: 'ABSENT'; role: null; ceiling: null; constrains: false }
  | { status: 'RECOGNIZED'; role: RoleName; definition: RoleDefinition; ceiling: readonly string[]; constrains: true }
  | { status: 'LABEL_ONLY'; role: string; ceiling: null; constrains: false; detail: string };

/**
 * Resolve a role string.
 *
 * Case- and whitespace-insensitive on the KNOWN names only. It deliberately does not fuzzy-match:
 * `treasurer` is not silently a CFO, and `CTO ` is. Guessing at intent is how a role layer
 * quietly grants something nobody asked for.
 */
export function resolveRole(raw: string | null | undefined): RoleResolution {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return { status: 'ABSENT', role: null, ceiling: null, constrains: false };
  }
  const norm = String(raw).trim().toLowerCase();
  if ((ROLE_NAMES as readonly string[]).includes(norm)) {
    const def = DEFINITIONS[norm as RoleName];
    return { status: 'RECOGNIZED', role: def.name, definition: def, ceiling: def.ceiling, constrains: true };
  }
  return {
    status: 'LABEL_ONLY',
    role: String(raw).trim(),
    ceiling: null,
    constrains: false,
    detail:
      `"${String(raw).trim()}" is not one of the roles that carry a ceiling ` +
      `(${ROLE_NAMES.join(', ')}). It is stored as a human label and constrains nothing. ` +
      `Do not read it as an authorization boundary.`,
  };
}

export interface RoleCeilingOutcome {
  /** What the role permits of the request. Equals `requested` when no role constrains. */
  allowed: string[];
  /** Requested capabilities the role's ceiling forbids. Empty when nothing was cut. */
  refused: string[];
  resolution: RoleResolution;
  /** Present whenever something was refused, or the role decorates rather than constrains. */
  detail?: string;
}

/**
 * Apply a role's ceiling to a requested capability set.
 *
 * FAILS CLOSED on a recognized role: anything the ceiling does not provably permit is refused,
 * not passed through. `intersect` and `permits` come from the mutation-tested algebra rather
 * than being re-derived here.
 *
 * CTO and CMO carry only `read:tool:*`, so any spend they are asked to carry is refused — that is
 * the point of those roles, not an edge case. The caller sees a `refused` list naming exactly what
 * the role would not carry.
 */
export function applyRoleCeiling(
  requested: readonly string[],
  raw: string | null | undefined,
): RoleCeilingOutcome {
  const resolution = resolveRole(raw);
  const req = [...requested];

  if (resolution.status !== 'RECOGNIZED') {
    return {
      allowed: req,
      refused: [],
      resolution,
      ...(resolution.status === 'LABEL_ONLY' ? { detail: resolution.detail } : {}),
    };
  }

  const ceiling = resolution.ceiling;
  const allowed = ceiling.length === 0 ? [] : intersect([...ceiling], req);
  const refused = req.filter((c) => !allowed.includes(c));

  return {
    allowed,
    refused,
    resolution,
    ...(refused.length > 0
      ? {
          detail:
            `role "${resolution.role}" does not carry ${refused.join(', ')} — ` +
            `${resolution.definition.rationale}`,
        }
      : {}),
  };
}

/**
 * Does a role permit a single capability? Convenience for a use-time check.
 * An unrecognized or absent role returns `null` — NOT `true`. "No opinion" and "permitted" are
 * different answers, and collapsing them is how an unenforced label becomes an accidental pass.
 */
export function rolePermits(raw: string | null | undefined, capability: string): boolean | null {
  const r = resolveRole(raw);
  if (r.status !== 'RECOGNIZED') return null;
  return r.ceiling.some((c) => permits(c, capability));
}

/** Every role and its ceiling, for a UI or an operator who wants to see the whole table. */
export function roleCatalog(): RoleDefinition[] {
  return ROLE_NAMES.map((n) => DEFINITIONS[n]);
}
