/**
 * EQUIVALENCE FENCE — `packages/trust-demo/src/verify-local.mjs` must behave identically
 * to the shipped `src/services/trust-harness-verify.ts`.
 *
 * WHY THE DUPLICATION EXISTS. `@hyperdag/trust-demo` is published to npm and run via
 * `npx` by people who have never cloned this repo, so it cannot import from `src/`
 * (TypeScript) or `dist/` (absent from the published tarball). This is the same reasoning
 * that governs `scripts/hooks/lane-write-guard.js` duplicating `write-lease.ts`: a
 * dependency is a way to fail, and a verifier that fails is a verifier that fails OPEN.
 *
 * WHY THIS TEST EXISTS. Duplication is only acceptable with a machine-checked equivalence.
 * Without this file the two copies drift, and the drift is invisible because each side
 * stays internally consistent — the exact failure mode LESSONS #3 describes. Change one
 * implementation and this fails until you change the other.
 *
 * HOW IT RUNS BOTH. The `.mjs` is executed in a real Node child process
 * (`tests/helpers/run-verify-local-cases.mjs`) because jest's VM sandbox refuses a genuine
 * dynamic `import()` without `--experimental-vm-modules`, and loosening the repo-wide jest
 * config to fit one test would be editing the checker to pass. The case matrix is declared
 * ONCE as JSON descriptors and both sides build the identical `verifyFn` from it, so there
 * is nothing for the two runners to disagree about except the behaviour under test.
 *
 * The verifier is INJECTED in every case, so this needs no WASM, no network and no fixture:
 * it pins the fail-closed decision logic. The cryptography is pinned separately by
 * `zkp-proof-verifier-crosscheck.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyProofLocally as tsImpl, halRequestHeaders as tsHalHeaders } from '../src/services/trust-harness-verify';

const STATEMENT = { agent_id: '00000000-0000-4000-8000-0000000000aa', repid_score: 2280, threshold: 999, tier: 'ESTABLISHED' };
const BYTES = 'QUJD';

type VerifyFnDescriptor =
  | { kind: 'null' }
  | { kind: 'notFunction' }
  | { kind: 'throws'; message: string }
  | { kind: 'returns'; value: unknown };

interface Case {
  name: string;
  proofBytes: unknown;
  statement: unknown;
  verifyFn: VerifyFnDescriptor;
}

/** MUST match buildVerifyFn in tests/helpers/run-verify-local-cases.mjs. */
function buildVerifyFn(d: VerifyFnDescriptor): unknown {
  switch (d.kind) {
    case 'null': return null;
    case 'notFunction': return 'nope';
    case 'throws': return async () => { throw new Error(d.message); };
    case 'returns': return async () => d.value;
    default: throw new Error('unknown descriptor');
  }
}

/** Every branch of the fail-closed contract, honest path included. */
const CASES: Case[] = [
  { name: 'no verifier available', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'null' } },
  { name: 'verifier is not a function', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'notFunction' } },
  { name: 'empty proof bytes', proofBytes: '', statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: true } } },
  { name: 'non-string proof bytes', proofBytes: 123, statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: true } } },
  { name: 'null statement', proofBytes: BYTES, statement: null, verifyFn: { kind: 'returns', value: { verified: true } } },
  { name: 'verifier throws', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'throws', message: 'boom' } },
  { name: 'verified is a truthy string, not a boolean', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: 'true' } } },
  { name: 'verifier returns undefined', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'returns', value: undefined } },
  { name: 'verified false with an error string', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: false, error: 'bad opening', verifier_version: '0.2.0', proof_size_bytes: 10673 } } },
  { name: 'verified false with no error string', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: false } } },
  { name: 'honest pass', proofBytes: BYTES, statement: STATEMENT, verifyFn: { kind: 'returns', value: { verified: true, error: null, verifier_version: '0.2.0', proof_size_bytes: 10673 } } },
];

const RUNNER = path.resolve(__dirname, 'helpers/run-verify-local-cases.mjs');

/** Results from the REAL .mjs, executed by a real Node process. Computed once. */
function runMjs(): Array<Record<string, unknown>> {
  const stdout = execFileSync(process.execPath, [RUNNER, JSON.stringify(CASES)], { encoding: 'utf8' });
  return JSON.parse(stdout);
}

describe('trust-demo verify-local.mjs === trust-harness-verify.ts', () => {
  let mjsResults: Array<Record<string, unknown>>;

  beforeAll(() => {
    mjsResults = runMjs();
  });

  test('the published copy loads as ESM and answers every case', () => {
    expect(mjsResults).toHaveLength(CASES.length);
  });

  test.each(CASES.map((c, i) => [c.name, i] as const))('agrees on: %s', async (_name, i) => {
    const ts = await (tsImpl as unknown as (x: unknown) => Promise<unknown>)({
      proofBytes: CASES[i].proofBytes,
      statement: CASES[i].statement,
      verifyFn: buildVerifyFn(CASES[i].verifyFn),
    });
    expect(mjsResults[i]).toEqual(ts);
  });

  test('fails CLOSED on everything that is not an explicit verified===true', () => {
    CASES.forEach((c, i) => {
      expect(mjsResults[i].verified).toBe(c.name === 'honest pass');
    });
  });
});

describe('trust-demo statement-shape check', () => {
  // Empirically pinned against the real WASM (v0.2.0): a statement missing `agent_id`
  // fails with "missing field `agent_id`" and one missing `tier` with "missing field
  // `tier`" — both BEFORE the proof is decoded. `repid_zkp_proofs.statement` stores only
  // {repid_score, threshold}, so GET /api/v1/repid/:id/proof MUST synthesise the other two.
  test('names exactly the fields @hyperdag/proof-verifier requires', () => {
    const probe = `
      import { REQUIRED_STATEMENT_FIELDS, missingStatementFields } from '${path.resolve(__dirname, '../packages/trust-demo/src/verify-local.mjs').replace(/\\/g, '/')}';
      process.stdout.write(JSON.stringify({
        required: [...REQUIRED_STATEMENT_FIELDS].sort(),
        missingFromStored: missingStatementFields({ repid_score: 1, threshold: 2 }).sort(),
        missingFromFull: missingStatementFields(${JSON.stringify(STATEMENT)}),
        missingFromNull: missingStatementFields(null).sort(),
      }));`;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }));
    expect(r.required).toEqual(['agent_id', 'repid_score', 'threshold', 'tier']);
    expect(r.missingFromStored).toEqual(['agent_id', 'tier']);
    expect(r.missingFromFull).toEqual([]);
    expect(r.missingFromNull).toEqual(['agent_id', 'repid_score', 'threshold', 'tier']);
  });
});

describe('halRequestHeaders is mirrored faithfully too', () => {
  // The HAL leg is opt-in in the CLI, which makes this MORE important, not less: the only
  // reason a keyless run is allowed to say "not consulted" instead of guessing is that
  // authentication is detected correctly. If the mirror drifted so that a present key
  // read as absent, the demo would silently downgrade a real quorum to a skip.
  const ENVS: Array<[string, NodeJS.ProcessEnv]> = [
    ['no key at all', {}],
    ['key present', { REPID_API_KEY: 'sk-test-123' }],
    ['key with surrounding whitespace', { REPID_API_KEY: '   sk-test-123   ' }],
    ['empty-string key', { REPID_API_KEY: '' }],
    ['whitespace-only key', { REPID_API_KEY: '   ' }],
  ];

  test.each(ENVS)('agrees on: %s', (_name, env) => {
    const probe = `
      import { halRequestHeaders } from '${path.resolve(__dirname, '../packages/trust-demo/src/verify-local.mjs').replace(/\\/g, '/')}';
      process.stdout.write(JSON.stringify(halRequestHeaders(${JSON.stringify(env)})));`;
    const mjs = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' }));
    expect(mjs).toEqual(tsHalHeaders(env));
  });

  test('a whitespace-only key is NOT treated as authenticated', () => {
    expect(tsHalHeaders({ REPID_API_KEY: '   ' }).authenticated).toBe(false);
    expect(tsHalHeaders({ REPID_API_KEY: 'sk-real' }).authenticated).toBe(true);
  });
});

describe('the bundled fixture is the synthetic one, never a production extract', () => {
  test('package fixture is byte-identical to the repo test fixture', () => {
    const a = readFileSync(path.resolve(__dirname, 'fixtures/zkp/leaf-rangecheck.synthetic.plonky3.bin'));
    const b = readFileSync(path.resolve(__dirname, '../packages/trust-demo/fixtures/leaf-rangecheck.synthetic.plonky3.bin'));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  test('the shipped fixture declares itself synthetic and carries no production agent id', () => {
    // The #376 fence in spirit: this package is PUBLIC and published to npm, so a real
    // proof + a real agent UUID would be a production extract wearing a fixture's clothes.
    // NIL-variant (0000…) is the fabricated marker.
    const meta = JSON.parse(
      readFileSync(path.resolve(__dirname, '../packages/trust-demo/fixtures/leaf-rangecheck.synthetic.json'), 'utf8'),
    );
    expect(meta.SYNTHETIC).toBe(true);
    expect(meta.statement.agent_id).toMatch(/^00000000-0000-/);
  });
});
