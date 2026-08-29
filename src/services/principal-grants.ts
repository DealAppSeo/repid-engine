/**
 * Principal-to-principal grants: mint / list / revoke, with real revocation.
 *
 * The MVP gap this closes (docs/policy/grants-authority.v0.md, trinity-ecosystem, G1-G8):
 * neither existing delegation primitive fit agent-to-agent authority. trinity-ecosystem's
 * `identity/delegation.ts` is principal-shaped (capabilities/caveats/expiry) but has "no
 * revocation registry, by design" (`did.ts`) — G6 is NOT_CHECKED there. This repo's own
 * `agent-delegation.ts` HAS real revocation (`revoked_at`, `revokeDelegation()`) but is
 * human-wallet -> agent, EIP-712 signed, gated off by default — not principal -> principal
 * (a PAI granting a CTO/CFO/CMO agent scoped authority).
 *
 * This module is that missing piece: principal -> principal, with the capability/caveat
 * attenuation algebra PORTED from trinity-ecosystem (`principal-capability.ts`,
 * `principal-caveat.ts` — see their headers), the mint-floor discipline from
 * `effective-authority.ts` (also ported, with an explicit, load-bearing R_route caveat — see
 * that file's header), and the revocation shape this repo's own `agent_delegations` already
 * proved out, extended to be always-available to the grantor rather than gated behind a flag.
 *
 * G1-G8 predicate coverage (docs/policy/grants-authority.v0.md), what this module measures:
 *   G1  spend mint requires grantor A_eff >= budget, builder >= floor        -- decideMint
 *   G2  child capabilities subset of parent                                  -- decideMint
 *   G3  child spend cap <= grantor A_eff (and <= parent's stated cap)        -- decideMint
 *   G4  depth <= MAX_DEPTH                                                   -- decideMint
 *   G5  expired => deny, not soft-allow                                      -- decideAuthorization
 *   G6  grantor may always revoke; grantee cannot block it                   -- decideRevoke
 *   G7  auditor != doer for cold/auditor-class grants                        -- decideMint
 *   G8  a grant never approves/denies payment directly (still a separate,
 *       observe-mode question) -- NOT this module's job; nothing here is wired into
 *       PAY_AUTH_MODE or the pay route. Enforcing G8 is "don't wire it up", not code to test.
 *
 * FOLLOW-UP (before merge): two gaps closed after comparing this module's first pass against
 * agent-delegation.ts's own established shape --
 *   - idempotency_key: a retried POST /api/v1/grants with the same key now returns the
 *     already-minted grant instead of risking a second one. See mintGrant().
 *   - signed mint intent: mint no longer trusts "whichever API key called this" as sufficient
 *     grantor consent. See principal-grant-intent.ts's header for the full reasoning, including
 *     why this deliberately does NOT touch the custodied-wallet-decryption path.
 */
import { db } from '../db';
import { logAgentEvent } from '../engine/agent-log';
import { permits, isAttenuationOf, excess } from './principal-capability';
import {
  type Caveat,
  type ActionContext,
  evaluateCaveats,
  caveatsPermit,
  isCaveatAttenuationOf,
  caveatViolations,
} from './principal-caveat';
import { effectiveAuthority, type EffectiveAuthority } from './effective-authority';
import { resolveAuthorityInputs } from './grantor-authority';
import { buildGrantIntentMessage, checkGrantIntentSignature, type SignatureCheck } from './principal-grant-intent';
import { applyRoleCeiling } from './principal-roles';

export const MAX_GRANT_DEPTH = 4; // ported constant: identity/delegation.ts MAX_DELEGATION_DEPTH

export type GrantClass = 'spend' | 'hot' | 'warm' | 'cold';

/** theta_hot / theta_warm / theta_cold, locked in grants-authority.v0.md. */
export const CLASS_FLOOR: Record<GrantClass, number> = {
  spend: 0, // spend uses budget-vs-A_eff (G1/G3), not a flat floor
  hot: 2000,
  warm: 500,
  cold: 0,
};

export interface GrantRow {
  id: string;
  grantor_agent_id: string;
  grantee_agent_id: string;
  parent_grant_id: string | null;
  depth: number;
  grant_class: GrantClass;
  capabilities: string[];
  caveats: Caveat[];
  role: string | null;
  audit_for: string | null;
  not_before: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  mint_reason: string;
  created_at: string;
  idempotency_key: string | null;
  grantor_signature: string | null;
  grantor_wallet_address_used: string | null;
  signature_status: 'VERIFIED' | 'NOT_CHECKED' | null;
}

// --- Mint: pure decision -----------------------------------------------------

export interface MintRequest {
  grantorAgentId: string;
  granteeAgentId: string;
  grantClass: GrantClass;
  capabilities: string[];
  caveats: Caveat[];
  ttlSeconds: number;
  role?: string | null;
  /** Required and checked (G7) when grantClass === 'cold': the principal being audited. */
  auditFor?: string | null;
  parent?: GrantRow | null; // null/undefined = root grant (depth 0)
}

export type MintDecision =
  | { allowed: true; depth: number; reason: string }
  | { allowed: false; reason: string };

/**
 * Pure — takes the grantor's already-resolved A_eff AND already-decided signature check rather
 * than computing either, so this stays unit-testable with fixtures. `mintGrant` below is the
 * DB-touching wrapper that resolves A_eff, the wallet lookup, and the parent chain, then calls
 * this.
 */
export function decideMint(req: MintRequest, grantorAuthority: EffectiveAuthority, signatureCheck: SignatureCheck): MintDecision {
  if (signatureCheck.status === 'FAILED') {
    return { allowed: false, reason: `mint intent signature check failed: ${signatureCheck.detail}` };
  }
  if (!Number.isFinite(req.ttlSeconds) || req.ttlSeconds <= 0) {
    return { allowed: false, reason: 'ttlSeconds is required and must be positive — a never-expiring grant is refused at mint' };
  }
  if (req.grantorAgentId === req.granteeAgentId) {
    return { allowed: false, reason: 'grantor and grantee are the same principal — self-grants are not narrowing' };
  }

  // G9 — ROLE CEILING. A named role bounds what this grant may carry; it never supplies
  // anything. Checked BEFORE the parent-attenuation and A_eff gates below, because a request the
  // role forbids should be refused on the role's own terms rather than surviving to fail later
  // for a reason that does not name it — a refusal whose reason points at the wrong control is
  // how the next reader loosens the wrong thing.
  //
  // An UNRECOGNIZED role is not a ceiling. It is stored as a label and constrains nothing, which
  // is what `role` has always done; making an unknown string suddenly refuse capabilities would
  // break live grants carrying free text like "Researcher / Data".
  const roleCeiling = applyRoleCeiling(req.capabilities, req.role);
  if (roleCeiling.refused.length > 0) {
    return {
      allowed: false,
      reason: `role ceiling refuses ${roleCeiling.refused.join(', ')}: ${roleCeiling.detail ?? 'not permitted by this role'}`,
    };
  }

  const depth = req.parent ? req.parent.depth + 1 : 0;
  // G4
  if (depth > MAX_GRANT_DEPTH) {
    return { allowed: false, reason: `depth ${depth} exceeds MAX_GRANT_DEPTH (${MAX_GRANT_DEPTH})` };
  }

  // G2/G3/time attenuation against the parent, only for a child mint.
  if (req.parent) {
    const p = req.parent;
    const excessCaps = excess(p.capabilities, req.capabilities);
    if (excessCaps.length > 0) {
      return { allowed: false, reason: `capabilities not covered by parent grant: ${excessCaps.join(', ')}` };
    }
    if (!isCaveatAttenuationOf(req.caveats, p.caveats)) {
      const violations = caveatViolations(req.caveats, p.caveats);
      return { allowed: false, reason: `caveats loosen the parent grant: ${violations.join('; ')}` };
    }
    const parentExpiresAtMs = Date.parse(p.expires_at);
    const childExpiresAtMs = Date.now() + req.ttlSeconds * 1000;
    if (childExpiresAtMs > parentExpiresAtMs) {
      return { allowed: false, reason: `child expiry would exceed parent's (parent expires ${p.expires_at})` };
    }
  }

  // G7 — cold/auditor grants: auditor must differ from the principal being audited.
  if (req.grantClass === 'cold') {
    if (!req.auditFor) {
      return { allowed: false, reason: 'grantClass "cold" requires auditFor (the principal being audited)' };
    }
    if (req.auditFor === req.granteeAgentId) {
      return { allowed: false, reason: 'auditor (grantee) must differ from auditFor — checker_must_not_be_doer' };
    }
    const nonReadCaps = req.capabilities.filter((c) => !c.startsWith('audit:') && !c.startsWith('read:'));
    if (nonReadCaps.length > 0) {
      return {
        allowed: false,
        reason:
          `cold/auditor grant requested non-read capabilities: ${nonReadCaps.join(', ')}. ` +
          `NOTE: this is a coarser check than trinity-ecosystem's analyseReadOnly() reachability ` +
          `analysis (this repo has no tool-effects map) — prefix-based, not reachability-proven.`,
      };
    }
  }

  // G1 — mint floors, by class.
  if (req.grantClass === 'spend') {
    const spendCaveat = req.caveats.find((c): c is Extract<Caveat, { type: 'maxValue' }> => c.type === 'maxValue');
    if (!spendCaveat) {
      return { allowed: false, reason: 'grantClass "spend" requires a maxValue caveat stating the budget' };
    }
    if (grantorAuthority.outcome === 'NOT_CHECKED') {
      return { allowed: false, reason: `grantor A_eff is NOT_CHECKED (${grantorAuthority.detail}) — spend grants cannot mint on unmeasured collateral` };
    }
    const aEff = grantorAuthority.aEff ?? 0;
    if (aEff < spendCaveat.amount) {
      return { allowed: false, reason: `grantor A_eff (${aEff}) is below the requested budget (${spendCaveat.amount} ${spendCaveat.asset})` };
    }
    // G3 against the parent's own stated cap (not netted for spend already consumed — no
    // spend-ledger exists yet; this is a stated-cap check, not a true-remaining-balance check).
    if (req.parent) {
      const parentCaveat = req.parent.caveats.find((c): c is Extract<Caveat, { type: 'maxValue' }> => c.type === 'maxValue');
      if (parentCaveat && spendCaveat.amount > parentCaveat.amount) {
        return { allowed: false, reason: `child budget (${spendCaveat.amount}) exceeds parent's stated cap (${parentCaveat.amount})` };
      }
    }
  } else if (req.grantClass === 'hot' || req.grantClass === 'warm') {
    const floor = CLASS_FLOOR[req.grantClass];
    if (grantorAuthority.outcome === 'NOT_CHECKED') {
      return { allowed: false, reason: `grantor A_eff is NOT_CHECKED (${grantorAuthority.detail}) — ${req.grantClass} routing grants require a measured floor` };
    }
    const aEff = grantorAuthority.aEff ?? 0;
    if (aEff < floor) {
      return { allowed: false, reason: `grantor A_eff (${aEff}) is below the ${req.grantClass} floor (${floor})` };
    }
  }
  // 'cold' has no A_eff floor (theta_cold = 0) beyond the G7 checks above.

  return {
    allowed: true,
    depth,
    reason: `mint permitted: class=${req.grantClass}, depth=${depth}, A_eff=${grantorAuthority.aEff ?? 'NOT_CHECKED'}, signature=${signatureCheck.status}`,
  };
}

// --- Liveness / authorization: pure ------------------------------------------

/** A grant is live only if it, and every ancestor in its chain, is unexpired and unrevoked. */
export function isChainLive(grant: GrantRow, ancestors: GrantRow[], now: Date = new Date()): { live: boolean; reason: string } {
  const chain = [grant, ...ancestors];
  for (const g of chain) {
    if (g.revoked_at !== null) {
      return { live: false, reason: `${g.id === grant.id ? 'this grant' : 'an ancestor grant'} (${g.id}) is revoked as of ${g.revoked_at}` };
    }
    const notBeforeMs = Date.parse(g.not_before);
    const expiresAtMs = Date.parse(g.expires_at);
    if (now.getTime() < notBeforeMs) {
      return { live: false, reason: `${g.id === grant.id ? 'this grant' : 'an ancestor grant'} (${g.id}) is not yet valid (notBefore ${g.not_before})` };
    }
    if (now.getTime() >= expiresAtMs) {
      // G5: expired is deny, not soft-allow.
      return { live: false, reason: `${g.id === grant.id ? 'this grant' : 'an ancestor grant'} (${g.id}) expired at ${g.expires_at} — validityWindow FAILED, authorizer_denied` };
    }
  }
  return { live: true, reason: 'grant and full ancestor chain are unrevoked and within their validity window' };
}

export interface AuthorizationDecision {
  authorized: boolean;
  outcome: 'MEASURED' | 'NOT_CHECKED' | 'FAILED';
  reason: string;
  capabilityChecked: string;
  caveatResults: ReturnType<typeof evaluateCaveats>;
}

/** G5 + capability/caveat check, combined. A denied liveness check short-circuits everything else. */
export function decideAuthorization(
  grant: GrantRow,
  ancestors: GrantRow[],
  requestedCapability: string,
  ctx: ActionContext,
  now: Date = new Date(),
): AuthorizationDecision {
  const liveness = isChainLive(grant, ancestors, now);
  if (!liveness.live) {
    return { authorized: false, outcome: 'FAILED', reason: liveness.reason, capabilityChecked: requestedCapability, caveatResults: [] };
  }
  if (!permits_any(grant.capabilities, requestedCapability)) {
    return {
      authorized: false,
      outcome: 'FAILED',
      reason: `'${requestedCapability}' is not covered by this grant's capabilities [${grant.capabilities.join(', ')}]`,
      capabilityChecked: requestedCapability,
      caveatResults: [],
    };
  }
  const caveatResults = evaluateCaveats(grant.caveats, ctx);
  if (!caveatsPermit(caveatResults)) {
    return { authorized: false, outcome: 'FAILED', reason: 'a caveat FAILED', capabilityChecked: requestedCapability, caveatResults };
  }
  const anyNotChecked = caveatResults.some((r) => r.outcome === 'NOT_CHECKED');
  return {
    authorized: true,
    outcome: anyNotChecked ? 'NOT_CHECKED' : 'MEASURED',
    reason: anyNotChecked ? 'authorized, but at least one caveat could not be checked from this context' : 'authorized: chain live, capability covered, all caveats verified',
    capabilityChecked: requestedCapability,
    caveatResults,
  };
}

function permits_any(held: string[], requested: string): boolean {
  return held.some((h) => permits(h, requested));
}

// --- Revoke: pure --------------------------------------------------------------

export type RevokeDecision = { allowed: true } | { allowed: false; reason: string };

/** G6: only the direct grantor of this specific link may revoke it. The grantee cannot block it. */
export function decideRevoke(grant: GrantRow, requestedByAgentId: string): RevokeDecision {
  if (grant.revoked_at !== null) {
    return { allowed: false, reason: 'already revoked' };
  }
  if (requestedByAgentId !== grant.grantor_agent_id) {
    return { allowed: false, reason: `only the grantor (${grant.grantor_agent_id}) may revoke this grant; grantee-initiated revoke is refused` };
  }
  return { allowed: true };
}

// --- DB wrappers -----------------------------------------------------------

export interface MintResult {
  ok: boolean;
  grant?: GrantRow;
  error?: string;
}

export async function mintGrant(
  req: MintRequest & { parentGrantId?: string | null; idempotencyKey?: string | null; signature?: string | null },
): Promise<MintResult> {
  // Idempotency FIRST, before any other work: a retried request with the same key returns the
  // grant that request already minted, rather than re-running mint logic (which could otherwise
  // mint a second grant, or re-deny a request that actually succeeded the first time).
  if (req.idempotencyKey) {
    const { data: existing } = await db
      .from('principal_grants')
      .select('*')
      .eq('idempotency_key', req.idempotencyKey)
      .maybeSingle();
    if (existing) {
      return { ok: true, grant: existing as unknown as GrantRow };
    }
  }

  let parent: GrantRow | null = null;
  if (req.parentGrantId) {
    const { data } = await db.from('principal_grants').select('*').eq('id', req.parentGrantId).maybeSingle();
    if (!data) return { ok: false, error: 'parent_grant_not_found' };
    parent = data as unknown as GrantRow;
  }

  const authorityResolution = await resolveAuthorityInputs(req.grantorAgentId);
  const grantorAuthority: EffectiveAuthority =
    authorityResolution.ok
      ? effectiveAuthority(authorityResolution.inputs)
      : { aEff: null, outcome: 'NOT_CHECKED', bindingTerm: null, detail: authorityResolution.detail, rRouteIsLedgerApproximation: true };

  // Signature check: look up the grantor's registered wallet_address (NOT its private key —
  // this never touches getDecryptedPrivateKey(); see principal-grant-intent.ts's header).
  const { data: grantorRow } = await db
    .from('repid_agents')
    .select('wallet_address')
    .eq('agent_name', req.grantorAgentId)
    .maybeSingle();
  const grantorWalletAddress = ((grantorRow as any)?.wallet_address ?? null) as string | null;
  const intentMessage = buildGrantIntentMessage({
    grantorAgentId: req.grantorAgentId,
    granteeAgentId: req.granteeAgentId,
    grantClass: req.grantClass,
    capabilities: req.capabilities,
    caveats: req.caveats,
    ttlSeconds: req.ttlSeconds,
    idempotencyKey: req.idempotencyKey ?? '',
  });
  const signatureCheck = checkGrantIntentSignature({
    grantorWalletAddress,
    message: intentMessage,
    signature: req.signature ?? null,
  });

  const decision = decideMint({ ...req, parent }, grantorAuthority, signatureCheck);
  if (!decision.allowed) {
    await logAgentEvent(
      { agent: req.grantorAgentId, action: 'principal_grant_mint_denied', metadata: { reason: decision.reason, granteeAgentId: req.granteeAgentId, grantClass: req.grantClass, signatureStatus: signatureCheck.status } },
      'warn',
    );
    return { ok: false, error: decision.reason };
  }

  const now = new Date();
  const notBefore = now.toISOString();
  const expiresAt = new Date(now.getTime() + req.ttlSeconds * 1000).toISOString();

  const { data, error } = await db
    .from('principal_grants')
    .insert({
      grantor_agent_id: req.grantorAgentId,
      grantee_agent_id: req.granteeAgentId,
      parent_grant_id: req.parentGrantId ?? null,
      depth: decision.depth,
      grant_class: req.grantClass,
      capabilities: req.capabilities,
      caveats: req.caveats,
      role: req.role ?? null,
      audit_for: req.auditFor ?? null,
      not_before: notBefore,
      expires_at: expiresAt,
      mint_reason: decision.reason,
      idempotency_key: req.idempotencyKey ?? null,
      grantor_signature: req.signature ?? null,
      grantor_wallet_address_used: signatureCheck.status === 'VERIFIED' ? signatureCheck.recoveredAddress : null,
      signature_status: signatureCheck.status,
    })
    .select('*')
    .single();

  if (error) {
    // A unique-violation on idempotency_key here means a concurrent request with the same key
    // won the race between our lookup above and this insert — fetch and return ITS grant rather
    // than reporting a spurious failure for what is, from the caller's perspective, a success.
    if (req.idempotencyKey && /idempotency_key/i.test(error.message)) {
      const { data: winner } = await db.from('principal_grants').select('*').eq('idempotency_key', req.idempotencyKey).maybeSingle();
      if (winner) return { ok: true, grant: winner as unknown as GrantRow };
    }
    return { ok: false, error: `db_error: ${error.message}` };
  }

  await logAgentEvent(
    {
      agent: req.grantorAgentId,
      action: 'principal_grant_minted',
      metadata: {
        grantId: (data as any).id, granteeAgentId: req.granteeAgentId, grantClass: req.grantClass, depth: decision.depth,
        expiresAt, aEff: grantorAuthority.aEff, aEffOutcome: grantorAuthority.outcome, signatureStatus: signatureCheck.status,
      },
    },
    'info',
  );

  return { ok: true, grant: data as unknown as GrantRow };
}

export interface ListedGrant extends GrantRow {
  live: boolean;
  liveReason: string;
}

/** All grants where `principalId` is the grantor or the grantee. Liveness is computed, not stored. */
export async function listGrants(principalId: string): Promise<ListedGrant[]> {
  const { data } = await db
    .from('principal_grants')
    .select('*')
    .or(`grantor_agent_id.eq.${principalId},grantee_agent_id.eq.${principalId}`)
    .order('created_at', { ascending: false });

  const rows = ((data as any[]) ?? []) as GrantRow[];
  const out: ListedGrant[] = [];
  for (const g of rows) {
    const ancestors = await loadAncestors(g);
    const liveness = isChainLive(g, ancestors);
    out.push({ ...g, live: liveness.live, liveReason: liveness.reason });
  }
  return out;
}

async function loadAncestors(grant: GrantRow): Promise<GrantRow[]> {
  const ancestors: GrantRow[] = [];
  let currentParentId = grant.parent_grant_id;
  // MAX_GRANT_DEPTH bounds the walk — a chain cannot be longer than that by construction.
  for (let i = 0; i < MAX_GRANT_DEPTH + 1 && currentParentId; i++) {
    const { data } = await db.from('principal_grants').select('*').eq('id', currentParentId).maybeSingle();
    if (!data) break;
    const row = data as unknown as GrantRow;
    ancestors.push(row);
    currentParentId = row.parent_grant_id;
  }
  return ancestors;
}

export interface RevokeResult {
  ok: boolean;
  error?: string;
}

export async function revokeGrant(grantId: string, requestedByAgentId: string): Promise<RevokeResult> {
  const { data } = await db.from('principal_grants').select('*').eq('id', grantId).maybeSingle();
  if (!data) return { ok: false, error: 'grant_not_found' };
  const grant = data as unknown as GrantRow;

  const decision = decideRevoke(grant, requestedByAgentId);
  if (!decision.allowed) {
    await logAgentEvent(
      { agent: requestedByAgentId, action: 'principal_grant_revoke_denied', metadata: { grantId, reason: decision.reason } },
      'warn',
    );
    return { ok: false, error: decision.reason };
  }

  const { error } = await db
    .from('principal_grants')
    .update({ revoked_at: new Date().toISOString(), revoked_by: requestedByAgentId })
    .eq('id', grantId)
    .is('revoked_at', null); // idempotent guard, matches agent-delegation.ts's revokeDelegation

  if (error) return { ok: false, error: `db_error: ${error.message}` };

  await logAgentEvent(
    { agent: requestedByAgentId, action: 'principal_grant_revoked', metadata: { grantId, granteeAgentId: grant.grantee_agent_id } },
    'info',
  );
  return { ok: true };
}

/** Full authorization check for a grant, resolving its ancestor chain first. Read-only. */
export async function checkAuthorization(
  grantId: string,
  requestedCapability: string,
  ctx: ActionContext,
): Promise<AuthorizationDecision | { authorized: false; outcome: 'FAILED'; reason: 'grant_not_found' }> {
  const { data } = await db.from('principal_grants').select('*').eq('id', grantId).maybeSingle();
  if (!data) return { authorized: false, outcome: 'FAILED', reason: 'grant_not_found' };
  const grant = data as unknown as GrantRow;
  const ancestors = await loadAncestors(grant);
  return decideAuthorization(grant, ancestors, requestedCapability, ctx);
}
