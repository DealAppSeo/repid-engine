/**
 * RRL Shadow Ledger — pluggable SINK for shadow-mode reputation deltas (WS2.3 Stage-0).
 * ----------------------------------------------------------------------------------------
 * STRICT SHADOW DISCIPLINE (WS2.3_SHADOW_SPEC):
 *   - This records what the RRL rule WOULD do. It NEVER writes `repid_score_events` or
 *     `repid_agents`. No ERC-8004, no ZKP, no on-chain, zero live RepID effect.
 *   - The entire subsystem is gated by `RRL_SHADOW_ENABLED` (default OFF). When disabled,
 *     `shadowLedgerEnabled()` is false and callers must not record.
 *
 * Two sinks:
 *   - JsonlShadowSink (DEFAULT): appends one JSON line per shadow entry to a file under
 *     reports/2026-07-18/. Zero infra, fully offline, auditable, replayable.
 *   - SupabaseShadowSink (STUB, interface only, NOT wired): shows the eventual DB-writer
 *     shape targeting the additive `rrl_shadow_ledger` table (migration written, NOT
 *     applied — prod DDL is Sean-only). Throws if used, so it can never silently write.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One shadow-ledger row — the would-be effect of an RRL delta, recorded, never applied. */
export interface ShadowLedgerEntry {
  ts: string; // ISO timestamp of the shadow computation
  agent_id: string; // agent whose response was scored
  event_id: string; // id of the ground-truth-bearing event (HAL/peer-verify/dispute/synthetic)
  event_source: 'hal' | 'peer_verify' | 'dispute' | 'synthetic' | 'replay';
  round: number; // logical time index within the replay/stream
  computed_delta: number; // the RRL delta that WOULD have been applied
  mechanisms_fired: string[]; // which mechanisms contributed (e.g. ['M8 escrow','M9 credential'])
  detector_fired: boolean; // an anti-gaming DETECTOR penalty fired (for FP-rate metrics)
  would_be_repid: number; // agent's RepID IF these shadow deltas were live (from 1000 baseline)
  live_repid: number | null; // the agent's ACTUAL current RepID, for divergence comparison
  note?: string; // freeform: 'synthetic:honest-calibrated', 'settle', etc.
}

/** A ledger sink. `record` must be side-effect-only-to-the-sink (no RepID writes ever). */
export interface ShadowLedgerSink {
  readonly kind: string;
  record(entry: ShadowLedgerEntry): void;
  /** Flush/close any buffered handles. Idempotent. */
  close(): void;
}

/** Master gate. Shadow mode is OFF unless `RRL_SHADOW_ENABLED` is explicitly truthy. */
export function shadowLedgerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RRL_SHADOW_ENABLED ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Default resolved ledger path (append-only JSONL under the WS2.3 report dir). */
export function defaultLedgerPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'reports', '2026-07-18', 'rrl-shadow-ledger.jsonl');
}

/**
 * DEFAULT sink — append JSONL to disk. Creates the parent dir if missing. Each `record`
 * appends exactly one line; safe to tail while a replay runs. Never truncates existing data.
 */
export class JsonlShadowSink implements ShadowLedgerSink {
  readonly kind = 'jsonl';
  private readonly filePath: string;
  private stream: fs.WriteStream | null = null;

  constructor(filePath: string = defaultLedgerPath()) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /** Reset the ledger file (used at the start of a fresh replay run). */
  truncate(): void {
    this.close();
    fs.writeFileSync(this.filePath, '', 'utf8');
  }

  private ensureStream(): fs.WriteStream {
    if (!this.stream) this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    return this.stream;
  }

  record(entry: ShadowLedgerEntry): void {
    this.ensureStream().write(JSON.stringify(entry) + '\n');
  }

  get path(): string {
    return this.filePath;
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

/**
 * DB-writer sink — STUB / interface only. Intentionally NOT wired to any Supabase client.
 * The real implementation (Stage-0.5+) would insert into the additive `rrl_shadow_ledger`
 * table via the service-role client. It throws so it can never silently touch prod, and so
 * a mis-config in shadow mode fails loud instead of writing.
 */
export class SupabaseShadowSink implements ShadowLedgerSink {
  readonly kind = 'supabase-stub';
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts?: { table?: string }) {
    /* no client is constructed on purpose */
  }
  record(_entry: ShadowLedgerEntry): void {
    throw new Error(
      'SupabaseShadowSink is a STUB (WS2.3 Stage-0). DB writing is Stage-0.5+ and requires ' +
        'the rrl_shadow_ledger migration to be applied by Sean. Use JsonlShadowSink for now.',
    );
  }
  close(): void {
    /* nothing to close */
  }
}

/**
 * ShadowLedger — thin façade over a sink that HARD-ENFORCES the enable gate. If shadow
 * mode is not enabled, `record` is a no-op (so accidental calls in prod do nothing), and
 * `armed` is false. This is the only object callers should hold.
 */
export class ShadowLedger {
  private readonly sink: ShadowLedgerSink;
  readonly armed: boolean;
  private _count = 0;

  constructor(sink: ShadowLedgerSink = new JsonlShadowSink(), opts?: { forceArmed?: boolean }) {
    this.sink = sink;
    // Armed only when the env gate is on — UNLESS forceArmed (offline replay harness, which
    // is inherently shadow-only and has no live effect regardless of the env flag).
    this.armed = opts?.forceArmed === true || shadowLedgerEnabled();
  }

  record(entry: ShadowLedgerEntry): boolean {
    if (!this.armed) return false;
    this.sink.record(entry);
    this._count++;
    return true;
  }

  get count(): number {
    return this._count;
  }
  get sinkKind(): string {
    return this.sink.kind;
  }
  close(): void {
    this.sink.close();
  }
}
