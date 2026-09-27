/**
 * Verify the existing plonky3_range_check fixture, then one flipped byte.
 * Uses the Node WASM entry already in the tree. No new circuit. No chain write.
 * Prints the two outcomes only.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fixDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'zkp');

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(fixDir, 'leaf-rangecheck.synthetic.json'), 'utf8'));
if (meta.scheme !== 'plonky3_range_check') fail('fixture scheme is not plonky3_range_check');
if (meta.SYNTHETIC !== true) fail('fixture is not synthetic');

const proof = readFileSync(join(fixDir, meta.proof_file));
if (proof.length !== meta.proof_bytes_len) fail('fixture length does not match');

const verifier = require('@hyperdag/proof-verifier/pkg-node/hyperdag_proof_verifier.js');
verifier.init_panic_hook();

function verified(bytes) {
  const raw = JSON.parse(
    verifier.verify_proof(JSON.stringify({
      proof_bytes: bytes.toString('base64'),
      statement: meta.statement,
    })),
  );
  return raw.verified === true;
}

const honest = verified(proof);
const tampered = Buffer.from(proof);
tampered[0] = (tampered[0] ?? 0) ^ 0x01;
if (tampered.equals(proof)) fail('flip did not change a byte');
const flipped = verified(tampered);

if (honest !== true) fail('honest fixture did not verify');
if (flipped !== false) fail('flipped byte verified');

process.stdout.write('scheme\tplonky3_range_check\nhonest\tverified\nflipped\trejected\n');
