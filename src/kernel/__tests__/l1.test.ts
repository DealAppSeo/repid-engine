/**
 * src/kernel/l1.ts: the L1 policy at the spec ceilings, the review sheet derived from the payload bytes, and
 * the durable ledger. Throwaway wallets in memory; no chain, no network.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { TypedDataEncoder, Wallet } from 'ethers';
import { BASE_SEPOLIA_USDC, buildL1, l1ConfigProblems, l1LedgerPathProblem, policyFromPayload, renderReviewSheet, type L1Config } from '../l1';
import { POLICY_DOMAIN_V2, POLICY_TYPES_V2, policyHash, verifyOwnerPolicy } from '../policy';
import { LedgerIntegrityError, createJsonlStore } from '../store';

const offline = { getCode: async () => '0x', call: async () => { throw new Error('offline'); } };
const owner = Wallet.createRandom();
const cfg = (over: Partial<L1Config> = {}): L1Config => ({
  subject: 'l1-buyer-test-0001',
  owner: owner.address,
  buyer: Wallet.createRandom().address,
  seller: Wallet.createRandom().address,
  per_tx_raw: '1000000',
  daily_raw: '10000000',
  total_raw: '20000000',
  tx_per_day: 20,
  max_fee_wei: '100000000000000',
  not_before: 1_800_000_000,
  expires_at: 1_800_000_000 + 48 * 3600,
  kill_switch_path: join(tmpdir(), 'L1-KILL'),
  evaluator_sha256: 'a'.repeat(64),
  nonce: '1',
  ...over,
});
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sign = async (w: Wallet, payload: string) => {
  const t = JSON.parse(payload);
  const { EIP712Domain: _d, ...types } = t.types;
  return w.signTypedData(t.domain, types, t.message);
};

describe('the L1 policy at the spec limits', () => {
  const c = cfg();
  const a = buildL1(c);

  it('is a v2 kernel policy that spends only, pays only the seller, and binds the experiment policy', () => {
    expect(a.policy.actions).toEqual(['spend']);
    expect(a.policy.payees).toEqual([a.experiment.wallets.seller[0]]);
    expect(a.policy.authorized_impl_hashes).toEqual([`l1.experiment.sha256:${a.experiment.policy_id}`]);
    expect(a.digest).toBe(TypedDataEncoder.hash(POLICY_DOMAIN_V2, POLICY_TYPES_V2, JSON.parse(a.payload).message));
    expect(a.digest).toBe(policyHash(a.policy));
    expect(JSON.parse(a.payload).domain).toEqual({ name: 'HyperDAG Kernel Owner Policy', version: '2', chainId: 84532 });
    expect(a.experiment).toMatchObject({ level: 1, chain_id: 84532, assets: [{ symbol: 'USDC', contract: BASE_SEPOLIA_USDC, decimals: 6 }], max_tx_count: 20, operations: ['pay'] });
  });

  it('a signature over the payload bytes is a signature the kernel verifies', async () => {
    const v = await verifyOwnerPolicy(a.policy, await sign(owner, a.payload), offline);
    expect(v.status).toBe('VERIFIED');
  });

  it.each([
    ['per payment above 1 USDC', { per_tx_raw: '1000001' }],
    ['a day above 10 USDC', { daily_raw: '10000001' }],
    ['a total above 20 USDC', { total_raw: '20000001' }],
    ['more than 20 payments a day', { tx_per_day: 21 }],
    ['longer than 7 days', { expires_at: 1_800_000_000 + 7 * 86_400 + 1 }],
    ['gas above 0.0001 ETH a payment', { max_fee_wei: '100000000000001' }],
    ['the owner is a disposable wallet', { buyer: owner.address }],
    ['buyer and seller are the same wallet', { seller: c.buyer }],
    ['a relative kill-switch path', { kill_switch_path: 'KILL' }],
    ['a zero cap', { per_tx_raw: '0' }],
  ])('refuses a config with %s, never trims it', (_n, over) => {
    expect(l1ConfigProblems(cfg({ ...c, ...over }))).not.toEqual([]);
    expect(() => buildL1(cfg({ ...c, ...over }))).toThrow(/L1 config refused/);
  });

  it('accepts exactly the ceilings', () => {
    expect(l1ConfigProblems(cfg({ ...c, expires_at: c.not_before + 7 * 86_400 }))).toEqual([]);
  });
});

describe('the review sheet is derived from the bytes that are signed', () => {
  const a = buildL1(cfg());
  const exp = JSON.stringify(a.experiment, null, 2);
  const sheet = renderReviewSheet(a.payload, exp);

  it('prints the payload sha256 and the EIP-712 digest the signature covers', () => {
    expect(sheet).toContain(sha(a.payload));
    expect(sheet).toContain(a.digest);
    expect(sheet).toContain('Signing moves no funds and needs no gas');
    expect(sheet).toContain('the signature IS an authorization');
  });
  it('prints every limit in human units, read from the payload and the bound experiment policy', () => {
    for (const s of ['at most 1.0 USDC', 'at most 10.0 USDC and at most 20 payments', 'at most 20.0 USDC', a.policy.owner, a.policy.payees![0]!, a.experiment.kill_switch_path.replace(/\\/g, '\\'), 'chainId 84532', BASE_SEPOLIA_USDC, '(48 h)']) {
      expect(sheet).toContain(s);
    }
  });
  it('carries both documents verbatim', () => {
    expect(sheet).toContain(a.payload);
    expect(sheet).toContain(exp);
  });

  const edit = (f: (t: any) => void) => {
    const t = JSON.parse(a.payload);
    f(t);
    return JSON.stringify(t, null, 2);
  };
  it.each([
    ['a cap raised in the payload', edit((t) => { t.message.perTxRaw = '900000'; })],
    ['the domain version changed', edit((t) => { t.domain.version = '1'; })],
    ['a verifyingContract added', edit((t) => { t.domain.verifyingContract = owner.address; })],
    ['an extra action', edit((t) => { t.message.actions = ['spend', 'tool']; })],
    ['a second payee', edit((t) => { t.message.payees.push(owner.address); })],
    ['the owner spelled in lower case', edit((t) => { t.message.owner = String(t.message.owner).toLowerCase(); })],
    ['the binding pointing at another experiment policy', edit((t) => { t.message.authorizedImplHashes = [`l1.experiment.sha256:${'b'.repeat(64)}`]; })],
    ['an extra type field', edit((t) => { t.types.OwnerPolicy.push({ name: 'note', type: 'string' }); })],
  ])('refuses to render when the payload has %s', (_n, payload) => {
    expect(() => renderReviewSheet(payload, exp)).toThrow(/review sheet refused/);
  });
  it('refuses to render when the experiment policy was edited (kill switch moved) or re-stamped', () => {
    const t = JSON.parse(exp);
    t.kill_switch_path = join(tmpdir(), 'elsewhere');
    expect(() => renderReviewSheet(a.payload, JSON.stringify(t))).toThrow(/review sheet refused/);
  });
  it('policyFromPayload reads back exactly the policy that was built', () => {
    const r = policyFromPayload(a.payload);
    expect(r.ok && r.policy).toEqual(a.policy);
  });
});

describe('the durable L1 ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'l1-ledger-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('create:false never creates the file: a write and a read both refuse, and nothing appears', async () => {
    const p = join(dir, 'missing', 'ledger.jsonl');
    const s = createJsonlStore(p, { create: false });
    await expect(s.readAll()).rejects.toBeInstanceOf(LedgerIntegrityError);
    await expect(s.append({ kind: 'policy', recorded_at: 'x', policy: { policy: buildL1(cfg()).policy, signature: '0x00' } })).rejects.toThrow();
    expect(existsSync(p)).toBe(false);
  });
  it('control: the default store still reads a missing file as empty and creates it on write', async () => {
    const p = join(dir, 'default', 'ledger.jsonl');
    const s = createJsonlStore(p);
    await expect(s.readAll()).resolves.toEqual([]);
    await s.append({ kind: 'policy', recorded_at: 'x', policy: { policy: buildL1(cfg()).policy, signature: '0x00' } });
    expect(existsSync(p)).toBe(true);
  });
  it.each([
    ['a relative path', 'ledger.jsonl', true],
    ['the OS temp directory', join(tmpdir(), 'hyperdag-kernel', 'ledger.jsonl'), true],
    ['the temp directory itself', tmpdir(), true],
    ['a sibling of the temp directory', join(tmpdir(), '..', 'Temp-not', 'ledger.jsonl'), false],
    ['another absolute folder', resolve(tmpdir(), '..', '..', 'l1-durable', 'kernel-ledger.jsonl'), false],
  ])('path rule: %s', (_n, p, refused) => {
    const out = l1LedgerPathProblem(p, tmpdir());
    expect(out !== null).toBe(refused);
  });
});
