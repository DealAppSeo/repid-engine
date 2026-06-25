/**
 * TAMPER-EVIDENT GOVERNANCE TRACE (CC, 2026-06-25 r6 Phase 3).
 *
 * Round-5 left trace integrity at ~67%. Two properties are required:
 *  1. TAMPER-EVIDENT: each entry is hash-chained (entry.hash = sha256(prevHash · seq · ts · payload)),
 *     so altering or deleting ANY past entry breaks the chain and `verify()` pinpoints where.
 *  2. UNSUPPRESSABLE: the trace is written through a fail-closed sink — if the write fails, the gate
 *     BLOCKS (see governance-safe.ts). You cannot suppress the log to hide an action.
 */
import * as crypto from 'crypto';

export interface TraceEntry {
  seq: number;
  ts: number;
  prevHash: string;
  payload: unknown;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/** Stable, key-sorted JSON so the hash is deterministic regardless of key order. */
export function canonicalJson(x: unknown): string {
  const seen = new WeakSet();
  const norm = (v: any): any => {
    if (v && typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.map(norm);
      return Object.keys(v).sort().reduce<Record<string, any>>((o, k) => ((o[k] = norm(v[k])), o), {});
    }
    return v;
  };
  return JSON.stringify(norm(x));
}

export function computeEntryHash(prevHash: string, seq: number, ts: number, payload: unknown): string {
  return crypto.createHash('sha256').update(`${prevHash}|${seq}|${ts}|${canonicalJson(payload)}`).digest('hex');
}

export class TraceChain {
  private entries: TraceEntry[] = [];

  append(payload: unknown, ts: number): TraceEntry {
    const prev = this.entries[this.entries.length - 1];
    const prevHash = prev ? prev.hash : GENESIS;
    const seq = this.entries.length;
    const hash = computeEntryHash(prevHash, seq, ts, payload);
    const entry: TraceEntry = { seq, ts, prevHash, payload, hash };
    this.entries.push(entry);
    return entry;
  }

  /** Recompute every hash + link; returns the first broken seq if tampered. */
  verify(): { ok: boolean; brokenAt?: number; reason?: string } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      if (e.prevHash !== prevHash) return { ok: false, brokenAt: e.seq, reason: 'prevHash link broken' };
      const recomputed = computeEntryHash(e.prevHash, e.seq, e.ts, e.payload);
      if (recomputed !== e.hash) return { ok: false, brokenAt: e.seq, reason: 'payload/hash mismatch (tampered)' };
      prevHash = e.hash;
    }
    return { ok: true };
  }

  all(): TraceEntry[] {
    return this.entries.slice();
  }
  last(): TraceEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }
  size(): number {
    return this.entries.length;
  }
}
