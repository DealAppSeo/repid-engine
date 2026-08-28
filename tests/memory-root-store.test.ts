import { recomputeRoot, rootMatchesStored, auditStoredCommitment, rowToLeaf, type MemoryLeafRow } from '../src/memory/memory-root-store';
import { LeanIMTPlus, encodeLeaf } from '../src/memory/leanimt-plus';

function rowsFrom(tree: LeanIMTPlus): MemoryLeafRow[] {
  return tree.leafSet().map((l, i) => ({
    leaf_index: i,
    value: l.value.toString(),
    next: l.next.toString(),
    tombstoned: l.tombstoned,
  }));
}

describe('memory-root-store: DB row <-> IndexedLeaf boundary', () => {
  it('recomputes the same root the tree itself reports', () => {
    const tree = new LeanIMTPlus();
    tree.insert(10n);
    tree.insert(20n);
    tree.insert(30n);
    const rows = rowsFrom(tree);
    expect(recomputeRoot(rows)).toBe(tree.root());
  });

  it('is deterministic under row reordering (position, not query order, binds the root)', () => {
    const tree = new LeanIMTPlus();
    tree.insert(5n);
    tree.insert(15n);
    tree.insert(25n);
    const rows = rowsFrom(tree);
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];
    expect(recomputeRoot(shuffled)).toBe(recomputeRoot(rows));
    expect(recomputeRoot(shuffled)).toBe(tree.root());
  });

  it('append changes the root deterministically and reproducibly', () => {
    const before = new LeanIMTPlus();
    before.insert(1n);
    const rootBefore = recomputeRoot(rowsFrom(before));

    const after = new LeanIMTPlus();
    after.insert(1n);
    after.insert(2n);
    const rootAfter1 = recomputeRoot(rowsFrom(after));
    const rootAfter2 = recomputeRoot(rowsFrom(after));

    expect(rootAfter1).toBe(rootAfter2); // same rows -> same root, every time
    expect(rootAfter1).not.toBe(rootBefore); // append actually moved the root
  });

  it('rootMatchesStored: true for the real root, false for a tampered one', () => {
    const tree = new LeanIMTPlus();
    tree.insert(7n);
    tree.insert(8n);
    const rows = rowsFrom(tree);
    expect(rootMatchesStored(rows, tree.root())).toBe(true);
    expect(rootMatchesStored(rows, '0xdeadbeef')).toBe(false);
  });

  it('rowToLeaf round-trips through encodeLeaf identically to the in-memory leaf', () => {
    const tree = new LeanIMTPlus();
    tree.insert(42n);
    const row = rowsFrom(tree)[1]!; // index 0 is the sentinel
    const leaf = tree.leafSet()[1]!;
    expect(encodeLeaf(rowToLeaf(row))).toBe(encodeLeaf(leaf));
  });

  it('a tombstoned row that skips a live value fails auditStoredCommitment (scope-2 check still fires through the DB boundary)', () => {
    const tree = new LeanIMTPlus();
    tree.insert(100n);
    tree.insert(200n);
    const root = tree.root();
    const rows = rowsFrom(tree);
    // Forge: relink the sentinel past the live value at 100, as if it were skipped.
    const sentinel = rows.find((r) => r.leaf_index === 0)!;
    const forged = rows.map((r) => (r === sentinel ? { ...r, next: '200' } : r));
    const audit = auditStoredCommitment(forged, root);
    expect(audit.ok).toBe(false);
  });
});
