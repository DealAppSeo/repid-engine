import { LeanIMTPlus, verifyMembership, verifyCurrentValidity } from '../src/memory/leanimt-plus';
import { recomputeRoot, type MemoryLeafRow } from '../src/memory/memory-root-store';
import { retrieveVerifiedMemory } from '../src/memory/memory-retrieval';
import { encodeEntry, type MemoryEntry } from '../src/memory/proof-carrying-memory';
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

describe('memory-retrieval: fetched rows -> verified entries with witnesses', () => {
  const entryA: MemoryEntry = { content: 'the sky is blue', source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };
  const entryB: MemoryEntry = { content: 'water is wet', source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };

  function build() {
    const tree = new LeanIMTPlus();
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryA))));
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    const leafRows = leafRowsFrom(tree);
    const storedRoot = recomputeRoot(leafRows);
    expect(storedRoot).toBe(tree.root());
    return { tree, leafRows, storedRoot };
  }

  it('returns each entry with a witness that verifies against the stored root', () => {
    const { storedRoot, leafRows } = build();
    const contentRows = [contentRowFor(entryA), contentRowFor(entryB)];
    const result = retrieveVerifiedMemory(leafRows, contentRows, storedRoot);
    expect(result.root).toBe(storedRoot);
    expect(result.entries).toHaveLength(2);
    for (const e of result.entries) {
      expect(verifyMembership(BigInt(e.value), e.inclusionProof, storedRoot)).toBe(true);
      expect(verifyCurrentValidity(BigInt(e.value), e.currentValidityProof, storedRoot)).toBe(true);
    }
    expect(result.entries.map((e) => e.entry.content).sort()).toEqual(['the sky is blue', 'water is wet']);
  });

  it('refuses (throws) when the fetched leaf rows do not recompute to the given stored root', () => {
    const { leafRows } = build();
    const contentRows = [contentRowFor(entryA)];
    expect(() => retrieveVerifiedMemory(leafRows, contentRows, '0x0' as any)).toThrow(/do not recompute to the stored root/);
  });

  it('drops a content row whose content has been tampered with, rather than returning it', () => {
    const { storedRoot, leafRows } = build();
    const goodRow = contentRowFor(entryA);
    const tamperedRow: MemoryContentRow = { ...contentRowFor(entryB), content: 'water is dry' };
    const result = retrieveVerifiedMemory(leafRows, [goodRow, tamperedRow], storedRoot);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.entry.content).toBe('the sky is blue');
  });

  it('drops a content row whose value has been revoked from the tree, rather than returning a stale witness', () => {
    const tree = new LeanIMTPlus();
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryA))));
    tree.insert(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    tree.revoke(BigInt(poseidon2LeafHash(encodeEntry(entryB))));
    const leafRows = leafRowsFrom(tree);
    const storedRoot = recomputeRoot(leafRows);
    const result = retrieveVerifiedMemory(leafRows, [contentRowFor(entryA), contentRowFor(entryB)], storedRoot);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.entry.content).toBe('the sky is blue');
  });

  it('returns an empty entry list for no content rows, without touching the tree', () => {
    const { storedRoot, leafRows } = build();
    const result = retrieveVerifiedMemory(leafRows, [], storedRoot);
    expect(result.entries).toEqual([]);
    expect(result.root).toBe(storedRoot);
  });
});
