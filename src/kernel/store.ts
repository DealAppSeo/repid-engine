/**
 * kernel/store.ts — persistence for the kernel. APPEND-ONLY, through an injected sink. NO DDL.
 *
 * The default sink is one JSONL file: a line per record, written, never rewritten. The durable sink
 * (createSupabaseStore, KERNEL_LEDGER_BACKEND=supabase) holds the same lines in a table that survives a
 * redeploy; its migration is Sean-applied.
 * Anything with `append` and `readAll` can stand in for the file, which is how the tests run
 * without touching a disk and how a table-backed sink would slot in later.
 *
 * WHAT THE LEDGER ADDS TO A SINK.
 *   - One lock around every receipt append, so two concurrent calls cannot both read the same chain
 *     tip and fork the chain. The lock is IN THIS PROCESS: the API runs one replica. Two replicas
 *     sharing one file would race, and that is a stated limit, not a hidden one. The durable sink
 *     (createSupabaseStore) closes it across replicas: its writes collide on `seq`, and a write that
 *     fails drops this process's index so the next call re-reads the store.
 *   - Under that lock, the ONE-USE AUTHORIZATION and the SPEND RESERVATION (P0-TK-04/05, P0-I3-16,
 *     RT-5). An ALLOW decision row consumes its authorization (receipt.ts `authorizationKey`) and
 *     reserves its amount. A second ALLOW decision row for a consumed key, or one whose amount no
 *     longer fits the limits it states, is refused. The builder sees the same state (`LedgerView`),
 *     so the gate writes a DENY instead of tripping this. Consumption is the row itself: it is as
 *     durable as the ledger, survives a restart (the index is rebuilt from the sink), and shares
 *     fate with the policy it consumes (both live in this ledger).
 *   - Validation BEFORE the write. A receipt that breaks an invariant is never persisted, so the
 *     gate cannot run a tool on a decision the ledger would not accept.
 *   - An index, built once from the sink: chain tip, latest policy per agent, spend rows, and the
 *     set of call ids with a persisted ALLOW decision row (invariant 7).
 *   - A refusal to read a damaged file. A line that does not parse, or a chain that does not verify,
 *     makes every read THROW — which the gate turns into NOT_CHECKED. Skipping a bad line would let
 *     a lost policy or a lost spend row read as "nothing there".
 */
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CAPABILITY_ENFORCED_CHECK } from './decide';
import { authorizationKey, validateReceipt, verifyReceiptChain } from './receipt';
import type {
  ChainTip,
  KernelLedger,
  KernelReceipt,
  KernelSink,
  LedgerRecord,
  LedgerView,
  SignedOwnerPolicy,
} from './types';

const DAY_S = 86_400;

/** The authorization an ALLOW decision row consumes, or null for any other row. */
function consumes(r: KernelReceipt): string | null {
  if (r.decision.verdict !== 'ALLOW' || r.decision.executed || r.decision.policy.policy_hash === null) return null;
  const enforced = r.decision.checks.some((c) => c.name === CAPABILITY_ENFORCED_CHECK);
  return authorizationKey(r.subject.agent.agent_id, r.request, r.decision.policy.policy_hash, enforced);
}

// ── sinks ───────────────────────────────────────────────────────────────────────────────────────

/** An in-memory sink for tests and demos. `records` is exposed so a test can read what was written. */
export function createMemoryStore(): KernelSink & { records: LedgerRecord[] } {
  const records: LedgerRecord[] = [];
  return {
    records,
    async append(record) {
      records.push(JSON.parse(JSON.stringify(record)) as LedgerRecord);
    },
    async readAll() {
      return records.map((r) => JSON.parse(JSON.stringify(r)) as LedgerRecord);
    },
  };
}

/**
 * Append-only JSONL. The directory is created on first write; nothing happens at import.
 *
 * `{ create: false }` is the DURABLE form (the L1 ledger, XC1 residual 2): the file must already exist and is
 * never created, by a write or by a read. A missing file THROWS instead of reading as an empty ledger, so a
 * wiped disk or a wrong path cannot hand a replayed old policy a clean slate (RT-3) or reset the spend history
 * (RT-3b): the gate turns the throw into NOT_CHECKED. Create the file once, deliberately (scripts/l1/init-ledger.ts).
 */
export function createJsonlStore(path: string, opts: { create?: boolean } = {}): KernelSink {
  const create = opts.create ?? true;
  return {
    async append(record) {
      if (create) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(record) + '\n';
      // Open for append, write, flush to disk, close: a record that returned is a record that is there.
      // Durable: append without O_CREAT, so a missing file is ENOENT here rather than a fresh empty ledger.
      const fh = await open(path, create ? 'a' : fsConstants.O_WRONLY | fsConstants.O_APPEND, 0o600);
      try {
        await fh.appendFile(line, 'utf8');
        await fh.datasync();
      } finally {
        await fh.close();
      }
    },
    async readAll() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          if (create) return [];
          throw new LedgerIntegrityError('the durable ledger file is missing; it is never recreated');
        }
        throw e;
      }
      const out: LedgerRecord[] = [];
      text.split('\n').forEach((line, i) => {
        if (line.trim() !== '') out.push(parseLine(line, i + 1));
      });
      return out;
    },
  };
}

/** Never skip a bad line: a skipped line could be the policy that capped spending. */
function parseLine(line: string, n: number): LedgerRecord {
  try {
    return JSON.parse(line) as LedgerRecord;
  } catch {
    throw new LedgerIntegrityError(`ledger line ${n} is not valid JSON`);
  }
}

/** Rows asked for per read. Reading stops only at an EMPTY page, so a server row cap below this cannot truncate the history. */
const LEDGER_PAGE = 1000;
const LEDGER_TIMEOUT_MS = 10_000;

/**
 * THE DURABLE SINK (KERNEL_LEDGER_BACKEND=supabase): public.kernel_ledger, one row per record holding the
 * exact JSONL line (text, so a receipt and its signature read back byte for byte). It survives a restart and
 * a redeploy, which the temp-dir file does not: the policy nonce high-water mark (RT-3) and the spend history
 * the daily/total caps sum (RT-3b) are read back, never reset. Migration: supabase/migrations/
 * 20261102130000_kernel_ledger.sql (append-only: no UPDATE, DELETE or TRUNCATE; service role only).
 *
 * `seq` is assigned HERE, 1 + the last row read, and is the primary key. Two writers that read the same tip
 * (two replicas) collide on it: the second insert fails, StoreLedger refuses that call and re-reads, so the
 * chain cannot fork and a stale replica cannot spend a budget another one already spent.
 *
 * FAIL CLOSED, LOUDLY. A read or write that fails throws (and is logged with console.error), which the gate
 * turns into NOT_CHECKED: spends are refused until the store is back. A gap in seq (a deleted row) throws
 * LedgerIntegrityError, so a lost policy or spend row never reads as "nothing there". A missing table (the
 * migration not applied) is a failed read: every spend is refused.
 */
export function createSupabaseStore(client: SupabaseClient, table = 'kernel_ledger'): KernelSink {
  let next: number | null = null;
  async function run<R extends { error: { message?: string } | null }>(what: 'read' | 'append', q: PromiseLike<R>): Promise<R> {
    let r: R | null = null;
    let err: { message?: string } | null = null;
    try {
      r = await q;
      err = r.error;
    } catch (e) {
      err = { message: e instanceof Error ? e.message : String(e) };
    }
    if (err || !r) {
      const msg = `kernel ledger store (${table}) ${what} failed: ${err?.message ?? 'no response'}; spends are refused until it is back`;
      console.error(`[kernel] ${msg}`);
      throw new Error(msg);
    }
    return r;
  }
  return {
    async append(record) {
      if (next === null) throw new LedgerIntegrityError('the durable ledger must be read before it is written');
      await run('append', client.from(table).insert({ seq: next, line: JSON.stringify(record) }).abortSignal(AbortSignal.timeout(LEDGER_TIMEOUT_MS)));
      next++;
    },
    async readAll() {
      next = null;
      const out: LedgerRecord[] = [];
      for (;;) {
        const { data } = await run(
          'read',
          client.from(table).select('seq,line').order('seq', { ascending: true }).range(out.length, out.length + LEDGER_PAGE - 1).abortSignal(AbortSignal.timeout(LEDGER_TIMEOUT_MS)),
        );
        const rows = (data ?? []) as Array<{ seq: number | string; line: string }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          if (Number(row.seq) !== out.length + 1) throw new LedgerIntegrityError(`ledger row ${out.length + 1} is missing (read seq ${row.seq})`);
          out.push(parseLine(row.line, out.length + 1));
        }
      }
      next = out.length + 1;
      return out;
    },
  };
}

// ── errors ──────────────────────────────────────────────────────────────────────────────────────

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

export class ReceiptInvalidError extends Error {
  readonly codes: string[];
  constructor(codes: string[]) {
    super(`receipt refused: ${codes.join(', ')}`);
    this.name = 'ReceiptInvalidError';
    this.codes = codes;
  }
}

export class PolicyNonceError extends Error {
  constructor() {
    super('a policy for this agent with an equal or higher nonce already exists');
    this.name = 'PolicyNonceError';
  }
}

// ── the ledger ──────────────────────────────────────────────────────────────────────────────────

interface SpendRow {
  agent_id: string;
  policy_hash: string | null;
  amount: bigint;
  ts_s: number;
}

export class StoreLedger implements KernelLedger {
  private loading: Promise<void> | null = null;
  private tip: ChainTip | null = null;
  private readonly byId = new Map<string, KernelReceipt[]>();
  private readonly decisionIds = new Set<string>();
  private readonly consumed = new Set<string>();
  private readonly policies = new Map<string, SignedOwnerPolicy>();
  private readonly spendRows: SpendRow[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * `receiptIndexer` is an OPTIONAL best-effort secondary sink, invoked once per appended receipt
   * AFTER the authoritative JSONL append + validate + chain-link succeed. It is injected only by the
   * production wiring (routes/kernel.ts → indexKernelReceiptToDb) so the generic ledger stays DB-free
   * and every test that constructs `new StoreLedger(sink)` is unaffected. Its errors can NEVER reach
   * the decision path: appendReceipt guards the call and swallows anything it throws.
   */
  constructor(
    private readonly sink: KernelSink,
    private readonly receiptIndexer?: (receipt: KernelReceipt) => void | Promise<void>,
  ) {}

  /** Run `fn` after everything queued before it, whether that succeeded or not. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loading) {
      this.loading = this.load().catch((e) => {
        this.loading = null; // a failed read is retried next time, never cached as "empty"
        throw e;
      });
    }
    return this.loading;
  }

  private async load(): Promise<void> {
    const records = await this.sink.readAll();
    const receipts: KernelReceipt[] = [];
    for (const rec of records) if (rec?.kind === 'receipt') receipts.push(rec.receipt);
    const chain = verifyReceiptChain(receipts);
    if (!chain.ok) throw new LedgerIntegrityError(`ledger chain is broken at entry ${chain.index}: ${chain.code}`);

    this.tip = null;
    this.byId.clear();
    this.decisionIds.clear();
    this.consumed.clear();
    this.policies.clear();
    this.spendRows.length = 0;
    for (const rec of records) {
      if (rec?.kind === 'receipt') this.indexReceipt(rec.receipt);
      else if (rec?.kind === 'policy') this.indexPolicy(rec.policy);
      else throw new LedgerIntegrityError('ledger holds a record of an unknown kind');
    }
  }

  private indexReceipt(r: KernelReceipt): void {
    this.tip = { receipt_id: r.header.receipt_id, receipt_hash: r.header.receipt_hash };
    const list = this.byId.get(r.header.receipt_id) ?? [];
    list.push(r);
    this.byId.set(r.header.receipt_id, list);
    // The DECISION row is the ALLOW with executed:false; the outcome row shares its call id.
    if (r.decision.verdict === 'ALLOW' && !r.decision.executed) {
      this.decisionIds.add(r.header.receipt_id);
      const key = consumes(r);
      if (key) this.consumed.add(key);
      if (r.request.tool.class === 'spend' && r.request.amount_raw !== null) {
        this.spendRows.push({
          agent_id: r.subject.agent.agent_id,
          policy_hash: r.decision.policy.policy_hash,
          amount: BigInt(r.request.amount_raw),
          ts_s: Math.floor(Date.parse(r.header.created_at) / 1000),
        });
      }
    }
  }

  private indexPolicy(p: SignedOwnerPolicy): void {
    const cur = this.policies.get(p.policy.subject);
    if (!cur || BigInt(p.policy.nonce) > BigInt(cur.policy.nonce)) this.policies.set(p.policy.subject, p);
  }

  /**
   * A write that failed may have landed anyway (a lost response), or failed because another writer got there
   * first (the durable sink's seq collision). Either way this process's index may no longer match the store,
   * so it is dropped and rebuilt from the sink on the next call, never patched up from memory.
   */
  private async write(record: LedgerRecord): Promise<void> {
    try {
      await this.sink.append(record);
    } catch (e) {
      this.loading = null;
      throw e;
    }
  }

  async appendReceipt(build: (tip: ChainTip | null, view: LedgerView) => KernelReceipt): Promise<KernelReceipt> {
    return this.locked(async () => {
      await this.ensureLoaded();
      const view: LedgerView = { consumed: (key) => this.consumed.has(key), spentTotals: (q) => this.totals(q) };
      const receipt = build(this.tip, view);
      const v = validateReceipt(receipt, { persisted_decision_ids: this.decisionIds });
      if (!v.ok) throw new ReceiptInvalidError([...new Set(v.errors.map((x) => x.code))]);
      const expectedPrev = this.tip?.receipt_hash ?? null;
      if (receipt.header.prev_hash !== expectedPrev) throw new ReceiptInvalidError(['broken_link']);
      // Compare-and-set, under the lock: an ALLOW decision row must not reuse an authorization...
      const key = consumes(receipt);
      if (key && this.consumed.has(key)) throw new ReceiptInvalidError(['authorization_consumed']);
      // ...and a spend must still fit the limits it states, counting every spend already reserved.
      if (key && receipt.request.tool.class === 'spend' && receipt.request.amount_raw !== null) {
        const amount = BigInt(receipt.request.amount_raw);
        const t = this.totals({
          agent_id: receipt.subject.agent.agent_id,
          policy_hash: receipt.decision.policy.policy_hash!,
          since_s: Math.floor(Date.parse(receipt.header.created_at) / 1000) - DAY_S,
        });
        const lim = receipt.decision.limits;
        if (amount > BigInt(lim.per_tx_raw) || BigInt(t.daily_raw) + amount > BigInt(lim.daily_raw) || BigInt(t.total_raw) + amount > BigInt(lim.total_raw)) {
          throw new ReceiptInvalidError(['spend_reservation_exceeded']);
        }
      }
      await this.write({ kind: 'receipt', receipt });
      this.indexReceipt(receipt);
      // BEST-EFFORT secondary index. The JSONL record above is authoritative and already durable;
      // this runs after it and can NEVER throw into the decision path. A missing table or any DB
      // error here is swallowed — fail-open for the index only (the ledger and the verdict stand).
      if (this.receiptIndexer) {
        try {
          await this.receiptIndexer(receipt);
        } catch (e) {
          console.warn(
            `[kernel] receipt index-write failed (ledger unaffected): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return receipt;
    });
  }

  async appendPolicy(signed: SignedOwnerPolicy, recordedAt: string): Promise<void> {
    return this.locked(async () => {
      await this.ensureLoaded();
      const cur = this.policies.get(signed.policy.subject);
      if (cur && BigInt(signed.policy.nonce) <= BigInt(cur.policy.nonce)) throw new PolicyNonceError();
      await this.write({ kind: 'policy', recorded_at: recordedAt, policy: signed });
      this.indexPolicy(signed);
    });
  }

  async latestPolicy(subject: string): Promise<SignedOwnerPolicy | null> {
    await this.ensureLoaded();
    return this.policies.get(subject) ?? null;
  }

  async spentTotals(q: { agent_id: string; policy_hash: string; since_s: number }): Promise<{ daily_raw: string; total_raw: string }> {
    await this.ensureLoaded();
    return this.totals(q);
  }

  private totals(q: { agent_id: string; policy_hash: string; since_s: number }): { daily_raw: string; total_raw: string } {
    let daily = 0n;
    let total = 0n;
    for (const row of this.spendRows) {
      if (row.agent_id !== q.agent_id) continue;
      if (row.ts_s >= q.since_s) daily += row.amount;
      if (row.policy_hash === q.policy_hash) total += row.amount;
    }
    return { daily_raw: daily.toString(), total_raw: total.toString() };
  }

  async findReceipts(callId: string): Promise<KernelReceipt[]> {
    await this.ensureLoaded();
    return [...(this.byId.get(callId) ?? [])];
  }

  /**
   * Calls whose effect is INDETERMINATE (P0-I2-08): an ALLOW decision row with no outcome row. The
   * gate hands the tool control right after that row is written, so the effect may or may not have
   * happened (its outcome write failed, the process died, or it is still running). Reconcile these
   * from outside, never retry them: the decision row consumed their one-use authorization, so a
   * retry is DENY(authorization_consumed) anyway.
   */
  async indeterminate(): Promise<string[]> {
    await this.ensureLoaded();
    return [...this.decisionIds].filter((id) => !(this.byId.get(id) ?? []).some((r) => r.decision.executed));
  }
}
