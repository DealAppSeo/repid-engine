/**
 * scripts/mesh-memory/demo-sse-cell.ts
 *
 * Runnable measurement for the sandbox SSE memory cell. Prints the exact
 * host's-eye view (all it holds: ciphertext + opaque HMAC tokens + one Merkle
 * root), then runs a keyword search and shows what the KEY-HOLDER recovers plus
 * the integrity proof. Synthetic data only; touches no DB / RepID / chain / env.
 *
 *   npx ts-node scripts/mesh-memory/demo-sse-cell.ts
 */

import { createCell, MeshMemoryClient, verifyProof } from '../../src/services/mesh-memory';

const CORPUS = [
  { id: 'm1', keywords: ['payments', 'escrow', 'usdc'], payload: { note: 'held payment until delivery verified' } },
  { id: 'm2', keywords: ['escrow', 'dispute'], payload: { note: 'buyer opened a dispute on escrow' } },
  { id: 'm3', keywords: ['routing', 'anfis'], payload: { note: 'routed to the cheap free-tier model' } },
];

function main() {
  const USER_KEY = 'demo-user-key-0123456789abcdef';
  const { client, cell } = createCell(USER_KEY, CORPUS);

  console.log('=== HOST VIEW (everything the untrusted store holds) ===');
  const view = cell.hostView();
  console.log('commitment root :', view.commitmentRoot);
  console.log('index tokens    :', Object.keys(view.index));
  console.log('record ids      :', Object.keys(view.records));
  console.log('sample record ct:', view.records['m1']!.ct.slice(0, 32), '...(AES-256-GCM)');
  console.log('  -> no plaintext, no keyword strings, no query in the clear.\n');

  console.log('=== KEY-HOLDER SEARCH: "escrow" ===');
  const hits = client.search(cell, 'escrow');
  for (const h of hits) {
    console.log(`  ${h.id}:`, JSON.stringify(h.payload), '| proofVerified=', h.proofVerified);
  }

  console.log('\n=== WRONG KEY (different user) searches "escrow" ===');
  const attacker = new MeshMemoryClient('some-other-users-key-abcdef012345');
  console.log('  hits:', attacker.search(cell, 'escrow').length, '(expected 0 — wrong tokens)');

  console.log('\n=== INTEGRITY PROOF (STUB — Merkle inclusion, NOT zero-knowledge) ===');
  const proof = hits[0]!.proof;
  console.log('  kind        :', proof.kind);
  console.log('  verifies    :', verifyProof(proof, cell.commitmentRoot()));
  console.log('  vs bad root :', verifyProof(proof, 'f'.repeat(64)), '(expected false)');

  // Assert the demo actually behaved, so this doubles as a smoke check.
  const ok =
    hits.map((h) => h.id).sort().join(',') === 'm1,m2' &&
    hits.every((h) => h.proofVerified) &&
    attacker.search(cell, 'escrow').length === 0;
  if (!ok) {
    console.error('\nDEMO FAILED: invariants not met');
    process.exit(1);
  }
  console.log('\nOK — write/query correct, wrong key blind, proofs verify.');
}

main();
