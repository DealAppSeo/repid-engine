/**
 * CHECK — G6: grantor revoke denies subsequent use.
 *
 * Re-derives trinity-ecosystem PR #117's "G6 measurement pack" (docs/policy/grants-authority.v0.md,
 * fixture F-G6) against the LIVE decideRevoke/isChainLive/decideAuthorization in
 * src/services/principal-grants.ts — the same functions tests/principal-grants.test.ts's
 * "F-G6 fixture — G6a-G6e" describe block exercises, re-derived here as its own standalone,
 * CI-wired artifact rather than left as "tests pass" alone. No stub that always returns denied:
 * this requires the real module to load and its real decisions to come back correctly-shaped.
 *
 * F-G6, verbatim: construct a 2-level chain (root human H -> grantor G -> grantee A), revoke
 * — never expire — the link under test, then present. G6a-G6e ALL MEASURED is what flips G6 in
 * grants-authority.v0.md from NOT_CHECKED to MEASURED.
 *
 * One deliberate divergence from the fixture's literal text (see also the test file's header):
 * the doc's G6b allows revoke by "the grantor (G, or H on the root)". This module's decideRevoke()
 * is stricter — only the DIRECT grantor of a specific link may revoke THAT link. A root human's
 * real power is G6c's cascade (revoke root -> every unexpired descendant denied), not a direct
 * override on a grandchild's row. Same end state for A, different, more auditable mechanism.
 * G6b here tests the as-implemented strict rule and records the divergence in `detail`.
 */
import { CheckResult, pass, fail } from '../lib/types';

const ID = 'g6-grantor-revoke';
const TITLE = 'G6 — grantor revoke denies subsequent use [trinity-ecosystem PR #117, F-G6]';

export async function g6GrantorRevokeCheck(): Promise<CheckResult> {
  let mod: typeof import('../../../src/services/principal-grants');
  try {
    // require (not dynamic import) so ts-node resolves the .ts module under CJS, matching
    // authority.ts's own loading pattern for this harness.
    mod = require('../../../src/services/principal-grants');
    if (typeof mod.decideRevoke !== 'function' || typeof mod.decideAuthorization !== 'function') {
      throw new Error('decideRevoke/decideAuthorization export missing');
    }
  } catch (e: any) {
    return fail(ID, TITLE, `could not load principal-grants: ${e?.message ?? e}`, true);
  }
  const { decideRevoke, decideAuthorization } = mod;

  const now = Date.now();
  const rootGrant = () => ({
    id: 'root-1', grantor_agent_id: 'human-h', grantee_agent_id: 'pai-g',
    parent_grant_id: null, depth: 0, grant_class: 'spend' as const,
    capabilities: ['pay:usdc'], caveats: [{ type: 'maxValue' as const, asset: 'USDC', amount: 1000 }],
    role: null, audit_for: null,
    not_before: new Date(now - 1000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(),
    revoked_at: null as string | null, revoked_by: null as string | null,
    mint_reason: 'g6 check fixture', created_at: new Date(now - 1000).toISOString(),
    idempotency_key: null, grantor_signature: null, grantor_wallet_address_used: null, signature_status: null,
  });
  const childGrant = (overrides: Partial<ReturnType<typeof rootGrant>> = {}) => ({
    ...rootGrant(),
    id: 'child-1', grantor_agent_id: 'pai-g', grantee_agent_id: 'agent-a',
    parent_grant_id: 'root-1', depth: 1, expires_at: new Date(now + 300_000).toISOString(),
    ...overrides,
  });
  const ctx = { value: { asset: 'USDC', amount: 10 } };
  const at = (ms: number) => new Date(now + ms);

  type Row = { id: string; predicate: string; measured: boolean; evidence: string };
  const rows: Row[] = [];

  // G6a — grantor revoke denies subsequent use, and the fixture is provably unexpired at check time.
  {
    const revoked = childGrant({ revoked_at: at(1000).toISOString(), revoked_by: 'pai-g' });
    const stillUnexpired = Date.parse(revoked.expires_at) > now + 2000;
    const d = decideAuthorization(revoked as any, [rootGrant() as any], 'pay:usdc', ctx, at(2000));
    const measured = stillUnexpired && !d.authorized && d.outcome === 'FAILED' && /revoked/.test(d.reason) && !/expired/.test(d.reason);
    rows.push({ id: 'G6a', predicate: 'grantor revoke denies subsequent use', measured, evidence: `unexpired=${stillUnexpired}, authorized=${d.authorized}, outcome=${d.outcome}, reason="${d.reason}"` });
  }

  // G6b — only the DIRECT grantor of this link may revoke it (strict, as-implemented; see header).
  {
    const child = childGrant();
    const byGrantee = decideRevoke(child as any, 'agent-a');
    const byRootHuman = decideRevoke(child as any, 'human-h');
    const byGrantor = decideRevoke(child as any, 'pai-g');
    const measured = !byGrantee.allowed && !byRootHuman.allowed && byGrantor.allowed;
    rows.push({ id: 'G6b', predicate: 'only the direct grantor may revoke (strict — divergence noted in header)', measured, evidence: `grantee.allowed=${byGrantee.allowed}, rootHuman.allowed=${byRootHuman.allowed}, grantor.allowed=${byGrantor.allowed}` });
  }

  // G6c — parent (root) revoke cascades to an unexpired, itself-untouched child.
  {
    const child = childGrant();
    const revokedRoot = { ...rootGrant(), revoked_at: at(1000).toISOString(), revoked_by: 'human-h' };
    const childUntouched = child.revoked_at === null;
    const stillUnexpired = Date.parse(child.expires_at) > now + 2000;
    const d = decideAuthorization(child as any, [revokedRoot as any], 'pay:usdc', ctx, at(2000));
    const measured = childUntouched && stillUnexpired && !d.authorized && d.outcome === 'FAILED' && /ancestor/.test(d.reason) && /revoked/.test(d.reason);
    rows.push({ id: 'G6c', predicate: 'parent revoke cascades to an untouched, unexpired child', measured, evidence: `childUntouched=${childUntouched}, unexpired=${stillUnexpired}, outcome=${d.outcome}, reason="${d.reason}"` });
  }

  // G6d — no bearer bytes to replay; every re-presentation re-checks live, none can succeed.
  {
    const revoked = childGrant({ revoked_at: at(1000).toISOString(), revoked_by: 'pai-g' });
    const presentations = [2000, 60_000, 250_000].map((ms) => decideAuthorization(revoked as any, [rootGrant() as any], 'pay:usdc', ctx, at(ms)));
    const measured = presentations.every((d) => !d.authorized && /revoked/.test(d.reason));
    rows.push({ id: 'G6d', predicate: 'no resurrection on repeat presentation (no bearer bytes to replay)', measured, evidence: `3 re-presentations, all denied=${measured}` });
  }

  // G6e — control: the SAME unrevoked child is authorized, proving G6a/c measure revocation, not a
  // fixture that would fail regardless (e.g. a mistaken capability or caveat mismatch).
  {
    const live = childGrant();
    const d = decideAuthorization(live as any, [rootGrant() as any], 'pay:usdc', ctx, at(2000));
    const measured = d.authorized && d.outcome === 'MEASURED';
    rows.push({ id: 'G6e', predicate: 'not G5 in disguise — unrevoked control is authorized', measured, evidence: `authorized=${d.authorized}, outcome=${d.outcome}` });
  }

  const allMeasured = rows.every((r) => r.measured);
  const summary = allMeasured
    ? 'G6a-G6e all MEASURED — grantor revoke denies subsequent use, only the direct grantor can revoke, cascades to unexpired descendants, no resurrection, isolated from G5/expiry'
    : `G6 NOT MEASURED — failing: ${rows.filter((r) => !r.measured).map((r) => r.id).join(', ')}`;

  return (allMeasured ? pass : fail)(ID, TITLE, summary, true, { fixture: 'F-G6 (trinity-ecosystem PR #117)', rows });
}
