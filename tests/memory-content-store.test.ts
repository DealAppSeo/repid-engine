import { rowToEntry, contentMatchesValue, verifiedEntry, type MemoryContentRow } from '../src/memory/memory-content-store';
import { encodeEntry, type MemoryEntry } from '../src/memory/proof-carrying-memory';
import { poseidon2LeafHash } from '../src/zkp/poseidon2-leaf';

function rowFor(entry: MemoryEntry): MemoryContentRow {
  return { value: poseidon2LeafHash(encodeEntry(entry)), ...entry };
}

describe('memory-content-store: DB row <-> MemoryEntry boundary', () => {
  const entry: MemoryEntry = { content: 'the sky is blue', source_id: 'agent-1', source_repid: 1200, hal_verdict: 'clean', epoch: 3 };

  it('rowToEntry round-trips the entry fields untouched', () => {
    const row = rowFor(entry);
    expect(rowToEntry(row)).toEqual(entry);
  });

  it('contentMatchesValue is true for a row whose value was actually derived from its content', () => {
    const row = rowFor(entry);
    expect(contentMatchesValue(row)).toBe(true);
  });

  it('contentMatchesValue is false when content drifts from what was committed', () => {
    const row = rowFor(entry);
    const tampered: MemoryContentRow = { ...row, content: 'the sky is red' };
    expect(contentMatchesValue(tampered)).toBe(false);
  });

  it('contentMatchesValue is false when any other committed field drifts (source_repid)', () => {
    const row = rowFor(entry);
    const tampered: MemoryContentRow = { ...row, source_repid: 9999 };
    expect(contentMatchesValue(tampered)).toBe(false);
  });

  it('contentMatchesValue is false when value is copied from a different entry', () => {
    const other: MemoryEntry = { ...entry, content: 'a different fact entirely' };
    const swapped: MemoryContentRow = { ...rowFor(entry), value: rowFor(other).value };
    expect(contentMatchesValue(swapped)).toBe(false);
  });

  it('verifiedEntry returns the entry for a matching row', () => {
    const row = rowFor(entry);
    expect(verifiedEntry(row)).toEqual(entry);
  });

  it('verifiedEntry throws for a tampered row rather than silently returning bad content', () => {
    const row = rowFor(entry);
    const tampered: MemoryContentRow = { ...row, content: 'not what was committed' };
    expect(() => verifiedEntry(tampered)).toThrow(/does not hash to its own claimed value/);
  });
});
