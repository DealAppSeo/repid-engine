import { LeanIMTPlus, verifyMembership, verifyNonMembership } from '../src/memory/leanimt-plus';
import { hydrateTree, type MemoryLeafRow } from '../src/memory/memory-root-store';

function rowsFrom(tree: LeanIMTPlus): MemoryLeafRow[] {
  return tree.leafSet().map((l, i) => ({
    leaf_index: i,
    value: l.value.toString(),
    next: l.next.toString(),
    tombstoned: l.tombstoned,
  }));
}

describe('LeanIMTPlus.fromLeaves / memory-root-store.hydrateTree: persisted-row -> live prover bridge', () => {
  it('a hydrated root matches the equivalently-built insert/revoke tree\'s root', () => {
    const built = new LeanIMTPlus();
    built.insert(10n);
    built.insert(20n);
    built.insert(30n);
    built.revoke(20n);
    const hydrated = hydrateTree(rowsFrom(built));
    expect(hydrated.root()).toBe(built.root());
  });

  it('a hydrated tree\'s membership witness verifies against that same root', () => {
    const built = new LeanIMTPlus();
    built.insert(5n);
    built.insert(15n);
    const hydrated = hydrateTree(rowsFrom(built));
    const witness = hydrated.membershipProof(15n);
    expect(verifyMembership(15n, witness, built.root())).toBe(true);
  });

  it('a hydrated tree\'s non-membership witness verifies a revoked value against that same root', () => {
    const built = new LeanIMTPlus();
    built.insert(5n);
    built.insert(15n);
    built.revoke(15n);
    const hydrated = hydrateTree(rowsFrom(built));
    const witness = hydrated.nonMembershipProof(15n);
    expect(verifyNonMembership(15n, witness, built.root())).toBe(true);
  });

  it('is order-independent on input row order (position comes from leaf_index, not array order)', () => {
    const built = new LeanIMTPlus();
    built.insert(1n);
    built.insert(2n);
    built.insert(3n);
    const rows = rowsFrom(built);
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];
    expect(hydrateTree(shuffled).root()).toBe(built.root());
  });

  it('rejects an empty row set', () => {
    expect(() => hydrateTree([])).toThrow(/non-empty/);
  });

  it('rejects a row set whose index-0 leaf is not the untombstoned sentinel', () => {
    const corrupt: MemoryLeafRow[] = [
      { leaf_index: 0, value: '7', next: '0', tombstoned: false },
    ];
    expect(() => hydrateTree(corrupt)).toThrow(/sentinel/);
  });
});
