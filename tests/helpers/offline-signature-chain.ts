/**
 * jest setupFiles entry: no unit test reaches a real chain to check a wallet signature.
 *
 * src/services/wallet-signature.ts falls back to Base Sepolia when ecrecover does not match, to
 * ask whether the address is a smart wallet. In a unit test that would make a verdict depend on
 * the network (the defect this repo has already paid for once, see jest.config.js). Here every
 * address has no code — i.e. is a plain wallet — so a wrong signature is simply invalid, exactly
 * as before smart wallets were supported. Tests of the smart-wallet paths pass their own chain.
 */
import { __setDefaultSignatureChain } from '../../src/services/wallet-signature';

__setDefaultSignatureChain({
  getCode: async () => '0x',
  call: async () => {
    throw new Error('offline-signature-chain: unit tests do not reach a chain');
  },
});
