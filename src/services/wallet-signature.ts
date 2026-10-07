/**
 * wallet-signature.ts — did this wallet sign this? For every kind of wallet, not only the oldest.
 *
 * WHY THIS EXISTS. Every wallet check in the bind path used `verifyMessage(...) === wallet`, which
 * is ecrecover: it can only ever succeed for a plain key-pair wallet (MetaMask, the Coinbase Wallet
 * extension in its classic mode). A smart wallet — the passkey kind with no seed phrase, which is
 * the easiest wallet to hand a non-developer — signs through its contract (ERC-1271), and before its
 * first transaction it is not even deployed yet, so it wraps the signature with the means to deploy
 * it (ERC-6492). ecrecover returns some unrelated address for both, and the person is told their
 * signature is bad when it is not.
 *
 * ORDER (ERC-6492 "Verifier side", adapted for a recovered-address comparison):
 *   1. Signature ends in the 6492 magic suffix → run the reference validator in one eth_call.
 *   2. ecrecover equals the claimed address → valid, and no network call is made. This is safe to
 *      try before ERC-1271 here because we only ever accept recovered === claimed: a contract
 *      wallet's address is not derivable from any private key, so an EOA signature cannot recover
 *      to it by accident (EIP-7702 accounts are real EOAs, and ecrecover is correct for them).
 *   3. The address has code → ask it `isValidSignature(hash, signature)`.
 *   4. Otherwise → not valid.
 *
 * THREE OUTCOMES, NEVER TWO. If the chain cannot be reached for steps 1 or 3, the answer is
 * `not_checked`, not `invalid`: we did not look, and saying "bad signature" would send the person
 * off to re-sign something that may have been fine. Callers refuse the action either way — an
 * unverified signature authorizes nothing — but the reason they give is the true one.
 */
import { AbiCoder, Interface, JsonRpcProvider, TypedDataEncoder, concat, getAddress, hashMessage, isAddress, recoverAddress, type TypedDataDomain, type TypedDataField } from 'ethers';
import { VALIDATE_SIG_OFFCHAIN_BYTECODE } from './erc6492-bytecode';

export const ERC6492_MAGIC_SUFFIX = '6492649264926492649264926492649264926492649264926492649264926492';
const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

/** The few chain reads this needs, so tests can supply a fake without a node. */
export interface SignatureChain {
  getCode(address: string): Promise<string>;
  call(tx: { to?: string; data: string }): Promise<string>;
}

export type WalletSignatureResult =
  | { ok: true; kind: 'eoa' | 'erc1271' | 'erc6492' }
  | { ok: false; reason: 'invalid' | 'not_checked'; detail: string };

let defaultChain: SignatureChain | null = null;

/** Base Sepolia, the one chain this product runs on. Override with BASE_SEPOLIA_RPC_URL. */
export function rpcSignatureChain(url = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'): SignatureChain {
  const provider = new JsonRpcProvider(url, 84532, { staticNetwork: true });
  return {
    getCode: (address) => provider.getCode(address),
    call: (tx) => provider.call(tx),
  };
}

/**
 * Replace the default chain. For the jest setup file only (tests/helpers/offline-signature-chain.ts),
 * so no unit test ever reaches a real RPC: there, every address is a plain wallet unless a test
 * passes its own chain. Pass null to go back to the lazily built Base Sepolia client.
 */
export function __setDefaultSignatureChain(chain: SignatureChain | null): void {
  defaultChain = chain;
}

function chainOrDefault(chain?: SignatureChain): SignatureChain {
  if (chain) return chain;
  defaultChain ??= rpcSignatureChain();
  return defaultChain;
}

function isHex(s: string): boolean {
  return /^0x[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0;
}

/**
 * Verify a signature over a 32-byte digest. Use the message/typed-data wrappers below unless the
 * caller already holds the digest.
 */
export async function verifyWalletSignature(params: {
  address: string;
  digest: string;
  signature: string;
  chain?: SignatureChain;
}): Promise<WalletSignatureResult> {
  const { digest, signature } = params;
  if (!isAddress(params.address) || !isHex(signature) || signature.length < 4) {
    return { ok: false, reason: 'invalid', detail: 'Malformed address or signature.' };
  }
  const address = getAddress(params.address);

  // 1. Counterfactual (not yet deployed) smart wallet.
  if (signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX)) {
    const data = concat([
      VALIDATE_SIG_OFFCHAIN_BYTECODE,
      AbiCoder.defaultAbiCoder().encode(['address', 'bytes32', 'bytes'], [address, digest, signature]),
    ]);
    try {
      const out = await chainOrDefault(params.chain).call({ data });
      return out === '0x01'
        ? { ok: true, kind: 'erc6492' }
        : { ok: false, reason: 'invalid', detail: 'The smart wallet did not accept this signature.' };
    } catch (e) {
      // A revert from the validator is the wallet or its factory refusing — an answer. Anything
      // else (no network, RPC error) is not one.
      if (isRevert(e)) return { ok: false, reason: 'invalid', detail: 'The smart wallet did not accept this signature.' };
      return { ok: false, reason: 'not_checked', detail: 'Could not reach the chain to check a smart-wallet signature.' };
    }
  }

  // 2. Plain key-pair wallet — no network needed.
  try {
    if (signature.length === 132 && recoverAddress(digest, signature).toLowerCase() === address.toLowerCase()) {
      return { ok: true, kind: 'eoa' };
    }
  } catch {
    /* not a well-formed 65-byte ECDSA signature; may still be a contract signature */
  }

  // 3. Deployed smart wallet.
  const chain = chainOrDefault(params.chain);
  let code: string;
  try {
    code = await chain.getCode(address);
  } catch {
    return { ok: false, reason: 'not_checked', detail: 'Could not reach the chain to check whether this is a smart wallet.' };
  }
  if (!code || code === '0x') {
    return { ok: false, reason: 'invalid', detail: 'The signature did not come from this wallet.' };
  }
  try {
    const out = await chain.call({ to: address, data: ERC1271.encodeFunctionData('isValidSignature', [digest, signature]) });
    const [magic] = ERC1271.decodeFunctionResult('isValidSignature', out);
    return String(magic).toLowerCase() === ERC1271_MAGIC
      ? { ok: true, kind: 'erc1271' }
      : { ok: false, reason: 'invalid', detail: 'The smart wallet did not accept this signature.' };
  } catch (e) {
    if (isRevert(e)) return { ok: false, reason: 'invalid', detail: 'The smart wallet did not accept this signature.' };
    return { ok: false, reason: 'not_checked', detail: 'Could not reach the chain to check a smart-wallet signature.' };
  }
}

/** personal_sign (EIP-191) over a plain-text message. */
export function verifyWalletMessage(address: string, message: string, signature: string, chain?: SignatureChain) {
  return verifyWalletSignature({ address, digest: hashMessage(message), signature, chain });
}

/** eth_signTypedData_v4 (EIP-712). */
export function verifyWalletTypedData(
  address: string,
  domain: TypedDataDomain,
  types: Record<string, TypedDataField[]>,
  value: Record<string, unknown>,
  signature: string,
  chain?: SignatureChain,
) {
  return verifyWalletSignature({ address, digest: TypedDataEncoder.hash(domain, types, value), signature, chain });
}

function isRevert(e: unknown): boolean {
  const err = e as { code?: string; data?: unknown; info?: { error?: { code?: number; message?: string } } };
  if (err?.code === 'CALL_EXCEPTION') return true;
  const inner = err?.info?.error;
  // JSON-RPC "execution reverted" is code 3 on most nodes, -32000 with a revert message on others.
  return inner?.code === 3 || /revert/i.test(inner?.message ?? '');
}
