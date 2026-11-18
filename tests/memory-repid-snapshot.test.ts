/**
 * Non-zero repidSnapshot + inclusion proof for a SYNTHETIC settled fixture, verified from (root, leaf, path)
 * alone, including by the standalone CLI in a child process. A broken sibling must fail.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepidSnapshot, proveSettled, verifySnapshotInclusion, type SettledEvent } from '../src/memory/repid-snapshot';
import { buildMemoryRootAttest, decodeAnchorFields } from '../src/memory/memory-root-anchor';
import { AbiCoder } from 'ethers';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'repid-snapshot', 'settled-fixture.json'), 'utf8'));
const events = fixture.events as SettledEvent[];
const snap = buildRepidSnapshot(fixture.agentId, fixture.epoch, events);
const proof = proveSettled(snap, fixture.targetContractId);

function flipHex(h: string): string {
  // change the low limb by 1, staying a canonical BabyBear value
  const last = parseInt(h.slice(-8), 16);
  return h.slice(0, -8) + ((last ^ 1) >>> 0).toString(16).padStart(8, '0');
}

describe('repid snapshot', () => {
  it('has a non-zero repidSnapshot equal to the latest settled score', () => {
    console.log('[evidence] snapshot', JSON.stringify({ snapshotId: snap.snapshotId, root: snap.root, leafCount: snap.leafCount, repidSnapshot: snap.repidSnapshot }));
    expect(snap.repidSnapshot).toBe(1231);
    expect(snap.root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of input order', () => {
    expect(buildRepidSnapshot(fixture.agentId, fixture.epoch, [...events].reverse()).root).toBe(snap.root);
  });

  it('inclusion proof for the settled fixture verifies, and carries its score', () => {
    console.log('[evidence] proof', JSON.stringify(proof));
    const v = verifySnapshotInclusion(proof);
    console.log('[evidence] verify', JSON.stringify(v));
    expect(v).toEqual(expect.objectContaining({ ok: true, score: 1205 }));
  });

  it('a broken sibling hash fails verification', () => {
    const bad = { ...proof, path: proof.path.map((s, i) => (i === 0 ? { ...s, sibling: flipHex(s.sibling) } : s)) };
    const v = verifySnapshotInclusion(bad);
    console.log('[evidence] broken-sibling verify', JSON.stringify(v));
    expect(v.ok).toBe(false);
  });

  it('a changed score in the leaf fails verification', () => {
    expect(verifySnapshotInclusion({ ...proof, leaf: { ...proof.leaf, scoreAfter: 9999 } }).ok).toBe(false);
  });

  it('refuses a zero score', () => {
    expect(() => buildRepidSnapshot(fixture.agentId, 1, [{ ...events[0]!, scoreAfter: 0 }])).toThrow(/positive/);
  });

  it('the anchor payload carries root and non-zero repidSnapshot, and decodes back', () => {
    const a = buildMemoryRootAttest({ agentId: snap.agentId, tier: 'ESTABLISHED', root: snap.root, epoch: snap.epoch, repidSnapshot: snap.repidSnapshot });
    const data = AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'bytes32', 'uint256', 'string', 'uint64'],
      [a.agentId, a.tier, a.merkleRoot, BigInt(a.repidSnapshot || 0), a.proofType, BigInt(a.proofId)],
    );
    const f = decodeAnchorFields(data)!;
    expect(f.merkleRoot).toBe(snap.root);
    expect(f.repidSnapshot).toBe(1231n);
    expect(f.proofId).toBe(7n);
  });

  it('standalone CLI verifies from a file holding only root + leaf + path (and fails a broken one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snap-'));
    const good = join(dir, 'good.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(good, JSON.stringify({ root: proof.root, leaf: proof.leaf, path: proof.path }));
    writeFileSync(bad, JSON.stringify({ root: proof.root, leaf: proof.leaf, path: proof.path.map((s, i) => (i === 0 ? { ...s, sibling: flipHex(s.sibling) } : s)) }));
    const cli = join(__dirname, '..', 'src', 'memory', 'repid-snapshot.ts');
    const run = (f: string) => {
      try { return { code: 0, out: execFileSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', cli, f], { encoding: 'utf8' }) }; }
      catch (e: any) { return { code: e.status as number, out: String(e.stdout) }; }
    };
    const g = run(good);
    const b = run(bad);
    console.log('[evidence] cli good', g.code, g.out.trim(), '| cli bad', b.code, b.out.trim());
    expect(g.code).toBe(0);
    expect(JSON.parse(g.out).ok).toBe(true);
    expect(b.code).toBe(1);
  }, 60_000);
});
