import { LeanIMTPlus, verifyMembership } from '../src/memory/leanimt-plus';
import { recomputeRoot, type MemoryLeafRow } from '../src/memory/memory-root-store';
import { retrieveVerifiedMemory } from '../src/memory/memory-retrieval';
import { bindAnswerFromRetrieval } from '../src/memory/answer-binding-retrieval';
import { verifyProofCarryingAnswer, encodeEntry, type MemoryEntry } from '../src/memory/proof-carrying-memory';
import { type MemoryContentRow } from '../src/memory/memory-content-store';
import { poseidon2LeafHash } from '../src/zkp/poseidon2-leaf';

function leafRowsFrom(tree: LeanIMTPlus): MemoryLeafRow[] {
  return tree.leafSet().map((l, i) => ({
    leaf_index: i,
    value: l.value.toString(),
    next: l.next.toString(),
    tombstoned: l.tombstoned,
  }));
}

function contentRowFor(entry: MemoryEntry): MemoryContentRow {
  return { value: poseidon2LeafHash(encodeEntry(entry)), ...entry };
}

describe('answer-binding-retrieval: binding an answer against a PERSISTED retrieval, not a live tree', () => {
  const entryA: MemoryEntry = { content: 'the sky is blue', source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };
  const entryB: MemoryEntry = { content: 'water is wet', source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };

  function build() {
    const tree = new LeanIMTPlus();
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryA))));
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    const leafRows = leafRowsFrom(tree);
    const storedRoot = recomputeRoot(leafRows);
    const retrieval = retrieveVerifiedMemory(leafRows, [contentRowFor(entryA), contentRowFor(entryB)], storedRoot);
    return { tree, retrieval, valueA: poseidon2LeafHash(encodeEntry(entryA)), valueB: poseidon2LeafHash(encodeEntry(entryB)) };
  }

  it('binds an answer citing verified retrieval entries, and the binding verifies', () => {
    const { retrieval, valueA, valueB } = build();
    const pca = bindAnswerFromRetrieval('the sky is blue and water is wet', [valueA, valueB], retrieval);
    expect(pca.memory_root).toBe(retrieval.root);
    expect(pca.citations).toHaveLength(2);
    const check = verifyProofCarryingAnswer(pca);
    expect(check.grounded).toBe(true);
    for (const c of pca.citations) {
      expect(verifyMembership(BigInt(c.value), c.witness, retrieval.root)).toBe(true);
    }
  });

  it('abstains (throws) when no values are cited', () => {
    const { retrieval } = build();
    expect(() => bindAnswerFromRetrieval('unsupported claim', [], retrieval)).toThrow(/abstain/);
  });

  it('abstains (throws) when a cited value was never in the retrieval (never added, revoked, or dropped)', () => {
    const { retrieval, valueA } = build();
    expect(() => bindAnswerFromRetrieval('claim', [valueA, 'not-a-real-value'], retrieval)).toThrow(/abstain.*not a currently verified member/);
  });

  it('abstains (throws) for a value that retrieveVerifiedMemory already dropped as revoked', () => {
    const tree = new LeanIMTPlus();
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryA))));
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    tree.revoke(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    const leafRows = leafRowsFrom(tree);
    const storedRoot = recomputeRoot(leafRows);
    const retrieval = retrieveVerifiedMemory(leafRows, [contentRowFor(entryA), contentRowFor(entryB)], storedRoot);
    const valueB = poseidon2LeafHash(encodeEntry(entryB));
    expect(() => bindAnswerFromRetrieval('claim', [valueB], retrieval)).toThrow(/abstain/);
  });
});
