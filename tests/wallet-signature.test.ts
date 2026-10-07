/**
 * wallet-signature.ts: plain wallets, deployed smart wallets (ERC-1271) and not-yet-deployed smart
 * wallets (ERC-6492), with "could not check" kept apart from "invalid".
 *
 * The chain is faked here. The same paths were run against real contracts on a local chain when
 * this landed (a mock 1271 wallet, a CREATE2 factory, the compiled 6492 validator): owner signatures
 * passed, stranger signatures failed, and the counterfactual wallet was still undeployed afterwards.
 */
import { AbiCoder, Interface, Wallet, concat, hashMessage } from 'ethers';
import {
  ERC6492_MAGIC_SUFFIX,
  verifyWalletMessage,
  verifyWalletTypedData,
  type SignatureChain,
} from '../src/services/wallet-signature';
import { VALIDATE_SIG_OFFCHAIN_BYTECODE } from '../src/services/erc6492-bytecode';

const MSG = 'HyperDAG — test';
const SMART = '0x00000000000000000000000000000000000000aa';
const iface = new Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
const magic = (v: string) => iface.encodeFunctionResult('isValidSignature', [v]);

function chain(over: Partial<SignatureChain> = {}): SignatureChain & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    getCode: over.getCode ?? (async () => '0x'),
    call: async (tx) => {
      calls.push(tx);
      if (!over.call) throw new Error('unexpected call');
      return over.call(tx);
    },
  };
}
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });

describe('plain key-pair wallets', () => {
  it('accepts the owner without touching the chain', async () => {
    const w = Wallet.createRandom();
    const c = chain({ getCode: async () => { throw new Error('should not be asked'); } });
    expect(await verifyWalletMessage(w.address, MSG, await w.signMessage(MSG), c)).toEqual({ ok: true, kind: 'eoa' });
  });
  it('refuses someone else when the address has no code', async () => {
    const w = Wallet.createRandom();
    const r = await verifyWalletMessage(w.address, MSG, await Wallet.createRandom().signMessage(MSG), chain());
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('refuses malformed input without asking the chain', async () => {
    const c = chain({ getCode: async () => { throw new Error('should not be asked'); } });
    expect(await verifyWalletMessage('0x12', MSG, '0xabcd', c)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWalletMessage(SMART, MSG, 'not-hex', c)).toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('typed data (EIP-712) goes through the same check', async () => {
    const w = Wallet.createRandom();
    const domain = { name: 'T', version: '1', chainId: 84532 };
    const types = { M: [{ name: 'x', type: 'string' }] };
    const sig = await w.signTypedData(domain, types, { x: 'y' });
    expect(await verifyWalletTypedData(w.address, domain, types, { x: 'y' }, sig, chain())).toEqual({ ok: true, kind: 'eoa' });
    expect(await verifyWalletTypedData(w.address, domain, types, { x: 'z' }, sig, chain())).toMatchObject({ ok: false });
  });
});

describe('deployed smart wallets (ERC-1271)', () => {
  const someSig = '0x' + '11'.repeat(65);
  it('accepts when the wallet answers the magic value, and asks it about the right digest', async () => {
    const c = chain({ getCode: async () => '0x6080', call: async () => magic('0x1626ba7e') });
    expect(await verifyWalletMessage(SMART, MSG, someSig, c)).toEqual({ ok: true, kind: 'erc1271' });
    const sent = c.calls[0] as { to: string; data: string };
    expect(sent.to.toLowerCase()).toBe(SMART);
    const [digest, sig] = iface.decodeFunctionData('isValidSignature', sent.data);
    expect(digest).toBe(hashMessage(MSG));
    expect(sig).toBe(someSig);
  });
  it('refuses any other answer, and a revert', async () => {
    expect(await verifyWalletMessage(SMART, MSG, someSig, chain({ getCode: async () => '0x6080', call: async () => magic('0xffffffff') })))
      .toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWalletMessage(SMART, MSG, someSig, chain({ getCode: async () => '0x6080', call: async () => { throw revert(); } })))
      .toMatchObject({ ok: false, reason: 'invalid' });
  });
  it('an unreachable chain is NOT CHECKED, never invalid', async () => {
    expect(await verifyWalletMessage(SMART, MSG, someSig, chain({ getCode: async () => { throw new Error('ECONNREFUSED'); } })))
      .toMatchObject({ ok: false, reason: 'not_checked' });
    expect(await verifyWalletMessage(SMART, MSG, someSig, chain({ getCode: async () => '0x6080', call: async () => { throw new Error('timeout'); } })))
      .toMatchObject({ ok: false, reason: 'not_checked' });
  });
});

describe('not-yet-deployed smart wallets (ERC-6492)', () => {
  const wrapped = concat([
    AbiCoder.defaultAbiCoder().encode(['address', 'bytes', 'bytes'], ['0x00000000000000000000000000000000000000bb', '0x1234', '0x' + '22'.repeat(65)]),
    '0x' + ERC6492_MAGIC_SUFFIX,
  ]);
  it('runs the reference validator as a deployless eth_call and accepts 0x01', async () => {
    const c = chain({ call: async () => '0x01' });
    expect(await verifyWalletMessage(SMART, MSG, wrapped, c)).toEqual({ ok: true, kind: 'erc6492' });
    const sent = c.calls[0] as { to?: string; data: string };
    expect(sent.to).toBeUndefined();
    expect(sent.data.startsWith(VALIDATE_SIG_OFFCHAIN_BYTECODE)).toBe(true);
    const [signer, digest, sig] = AbiCoder.defaultAbiCoder().decode(['address', 'bytes32', 'bytes'], '0x' + sent.data.slice(VALIDATE_SIG_OFFCHAIN_BYTECODE.length));
    expect(String(signer).toLowerCase()).toBe(SMART);
    expect(digest).toBe(hashMessage(MSG));
    expect(sig).toBe(wrapped);
  });
  it('refuses 0x00 and a revert; an unreachable chain is NOT CHECKED', async () => {
    expect(await verifyWalletMessage(SMART, MSG, wrapped, chain({ call: async () => '0x00' }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWalletMessage(SMART, MSG, wrapped, chain({ call: async () => { throw revert(); } }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWalletMessage(SMART, MSG, wrapped, chain({ call: async () => { throw new Error('fetch failed'); } }))).toMatchObject({ ok: false, reason: 'not_checked' });
  });
});
