/**
 * Child-process runner for the trust-demo equivalence fence.
 *
 * WHY A CHILD PROCESS. `packages/trust-demo/src/verify-local.mjs` is ESM. ts-jest compiles
 * the test file to CommonJS, and jest's VM sandbox refuses a genuine dynamic `import()`
 * without `--experimental-vm-modules`. Loosening the jest config repo-wide to accommodate
 * one test would be changing the checker to fit the input. Running the real file in a real
 * Node process instead keeps the module system honest and tests the artefact as published.
 *
 * WHY DESCRIPTORS RATHER THAN FUNCTIONS. A `verifyFn` cannot cross a process boundary, so
 * the case matrix is declared as JSON descriptors and each side builds the identical
 * function from the same descriptor. One matrix, two runners — there is nothing to drift.
 *
 * Protocol: cases JSON on argv[2], results JSON on stdout.
 */
import { verifyProofLocally } from '../../packages/trust-demo/src/verify-local.mjs';

/** Build a verifyFn from its declarative descriptor. Must match buildVerifyFn in the test. */
export function buildVerifyFn(d) {
  switch (d.kind) {
    case 'null': return null;
    case 'notFunction': return 'nope';
    case 'throws': return async () => { throw new Error(d.message); };
    case 'returns': return async () => d.value;
    default: throw new Error(`unknown verifyFn descriptor: ${d.kind}`);
  }
}

const cases = JSON.parse(process.argv[2]);
const results = [];
for (const c of cases) {
  results.push(await verifyProofLocally({
    proofBytes: c.proofBytes,
    statement: c.statement,
    verifyFn: buildVerifyFn(c.verifyFn),
  }));
}
process.stdout.write(JSON.stringify(results));
