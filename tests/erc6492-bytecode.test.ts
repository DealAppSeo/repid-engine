/**
 * The committed ERC-6492 validator bytecode is what the committed source compiles to.
 * A bytecode blob nobody can rebuild is a trust-me; this makes it a diff.
 */
import { VALIDATE_SIG_OFFCHAIN_BYTECODE } from '../src/services/erc6492-bytecode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { compileValidator } = require('../scripts/build-erc6492.cjs');

it('src/services/erc6492-bytecode.ts matches a fresh compile of contracts/erc6492', () => {
  expect(compileValidator()).toBe(VALIDATE_SIG_OFFCHAIN_BYTECODE);
}, 60_000);
