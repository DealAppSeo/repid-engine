/**
 * verifier-independence-d148.test.ts — the minimum-assurance rule, tested directly.
 *
 * D-148: `verifierIndependence` used to return `ok` whenever two owners merely resolved to
 * different keys in a shared namespace, without checking HOW STRONG that evidence was. Two
 * agents whose only owner evidence is an administrative builder_id (a foreign key set as a
 * side effect of agent creation, "NOT evidence of ownership") therefore read as independent
 * and earned canonical RepID tagged distinct-owner. The fix: independence requires owner
 * evidence ABOVE administrative on BOTH sides, in a shared namespace. Administrative can
 * still prove SAMENESS — a shared FK is a real shared link — it just cannot prove a DIFFERENCE.
 *
 * These drive the function over a mocked resolve fn, so they fix the exact OwnerResolution
 * shape each case produces (synthetic — no DB).
 */
// Stub the db module so importing bounty-authorization doesn't load config (which throws without
// SUPABASE_* env). Every test injects its own resolve fn, so the stub is never actually called.
jest.mock('../../db', () => ({ db: { from: () => ({}) } }));

import { verifierIndependence } from '../bounty-authorization';
import type { AgentRef, OwnerClaim, OwnerResolution } from '../agent-owner-resolver';

const admin = (key: string): OwnerClaim =>
  ({ source: 'repid_agents.builder_id', assurance: 'administrative', ownerKey: key, ownerKeyKind: 'builder_id', capUsdcPerTx: null, capUsdcTotal: null });
const walletBind = (key: string): OwnerClaim =>
  ({ source: 'human_agent_bindings', assurance: 'proven_wallet', ownerKey: key, ownerKeyKind: 'builder_id', capUsdcPerTx: null, capUsdcTotal: null });
const humanBind = (token: string): OwnerClaim =>
  ({ source: 'human_agent_bindings', assurance: 'proven_human', ownerKey: token, ownerKeyKind: 'human_sbt_token', capUsdcPerTx: null, capUsdcTotal: null });
const custody = (addr: string): OwnerClaim =>
  ({ source: 'agent_custodianship_links', assurance: 'attested_unverified', ownerKey: addr, ownerKeyKind: 'wallet', capUsdcPerTx: null, capUsdcTotal: null });

const resolved = (...claims: OwnerClaim[]): OwnerResolution =>
  ({ status: 'resolved', agentId: 'a', owner: claims[0] ?? null, claims, conflicts: [], reason: null, probes: [] });
const unknown = (): OwnerResolution =>
  ({ status: 'unknown', agentId: null, owner: null, claims: [], conflicts: [], reason: 'agent_not_found', probes: [] });

// resolve('V') => verifier resolution, resolve('C') => claimant resolution.
const call = (v: OwnerResolution, c: OwnerResolution) =>
  verifierIndependence('V', 'C', (async (ref: AgentRef) => (ref.id === 'V' ? v : c)));

describe('verifierIndependence — minimum-assurance rule (D-148)', () => {
  test('self-verification is refused before any owner lookup', async () => {
    const resolve = jest.fn();
    const r = await verifierIndependence('agent-x', 'AGENT-X', resolve as never); // case-insensitive
    expect(r).toMatchObject({ ok: false, reason: 'self_verification' });
    expect(resolve).not.toHaveBeenCalled();
  });

  test('THE FIX: two different administrative builder_ids are NOT independent', async () => {
    const r = await call(resolved(admin('AAA')), resolved(admin('BBB')));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('a shared administrative builder_id is same_owner (administrative CAN prove sameness)', async () => {
    const r = await call(resolved(admin('AAA')), resolved(admin('AAA')));
    expect(r).toMatchObject({ ok: false, reason: 'same_owner' });
  });

  test('two signed bindings naming different owners in one namespace => independent', async () => {
    const r = await call(resolved(walletBind('W1')), resolved(walletBind('W2')));
    expect(r).toEqual({ ok: true });
  });

  test('signed on one side, administrative-only on the other => not established', async () => {
    const r = await call(resolved(walletBind('W1')), resolved(admin('BBB')));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('overlapping controller claims: ANY shared owner => same_owner (fail closed over the overlap)', async () => {
    // Verifier has a strong binding AND still carries its administrative FK; the claimant shares that FK.
    // A moved wallet keeps its builder link — the shared claim must win, not the unshared strong one.
    const r = await call(resolved(walletBind('W1'), admin('SHARED')), resolved(admin('SHARED')));
    expect(r).toMatchObject({ ok: false, reason: 'same_owner' });
  });

  test('unverified custody (attested) outranks administrative: different wallets, shared namespace => independent', async () => {
    const r = await call(resolved(custody('0xaaa')), resolved(custody('0xbbb')));
    expect(r).toEqual({ ok: true });
  });

  test('unverified custody on one side, administrative-only on the other => not established', async () => {
    const r = await call(resolved(custody('0xaaa')), resolved(admin('BBB')));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('revocation: a revoked binding leaves only the administrative FK => not independent (D-148)', async () => {
    // probeBinding filters revoked_at IS NOT NULL, so a revoked owner contributes NO claim and the agent
    // falls back to its builder_id. Both sides administrative-only => owner_unknown, same as never bound.
    const r = await call(resolved(admin('wasBoundNowRevoked')), resolved(admin('alsoAdminOnly')));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('unknown controller on either side => not established (fail closed)', async () => {
    expect(await call(unknown(), resolved(walletBind('W2')))).toMatchObject({ ok: false, reason: 'owner_not_established' });
    expect(await call(resolved(walletBind('W1')), unknown())).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('different namespaces, both proven, cannot be compared (a builder_id and an SBT may be one human)', async () => {
    const r = await call(resolved(walletBind('W1')), resolved(humanBind('TOKEN2')));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('KNOWN CEILING — same-human/different-wallet reads as independent at proven_wallet', async () => {
    // Two different wallets the same human controls look like two owners here; only proven_human (an SBT,
    // precedence 1) could unify them. This is a documented limit of wallet-level evidence, not a silent bug.
    const r = await call(resolved(walletBind('humanWalletA')), resolved(walletBind('humanWalletB')));
    expect(r).toEqual({ ok: true });
  });

  test('a resolver that throws fails closed (owner_not_established), never independent', async () => {
    const r = await verifierIndependence('V', 'C', (async () => { throw new Error('db down'); }));
    expect(r).toMatchObject({ ok: false, reason: 'owner_not_established' });
  });

  test('AS-OF-TIME note: the function judges whatever snapshot the resolver returns', async () => {
    // verifierIndependence takes no timestamp — it is pure over the OwnerResolution it is handed. Resolving
    // ownership AS-OF the transaction time is the resolver's / caller's job; the shadow replay harness does
    // exactly that (reports/2026-11-04). Here we only assert the function reflects the snapshot given: the
    // SAME pair reads differently when the "as-of" snapshot carries a binding vs. when it does not.
    const atTradeTime = await call(resolved(admin('X')), resolved(admin('Y')));       // only FKs back then
    const afterBinding = await call(resolved(walletBind('X')), resolved(walletBind('Y'))); // signed later
    expect(atTradeTime).toMatchObject({ ok: false, reason: 'owner_not_established' });
    expect(afterBinding).toEqual({ ok: true });
  });
});
