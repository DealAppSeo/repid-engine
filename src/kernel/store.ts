/**
 * kernel/store.ts — persistence for the kernel. APPEND-ONLY, through an injected sink. NO DDL.
 *
 * The MVP sink is one JSONL file: a line per record, written, never rewritten. A migration would
 * make this a table; that is a database change on a shared project and is not this PR's to make.
 * Anything with `append` and `readAll` can stand in for the file, which is how the tests run
 * without touching a disk and how a table-backed sink would slot in later.
 *
 * WHAT THE LEDGER ADDS TO A SINK.
 *   - One lock around every receipt append, so two concurrent calls cannot both read the same chain
 *     tip and fork the chain. The lock is IN THIS PROCESS: the API runs one replica. Two replicas
 *     sharing one file would race, and that is a stated limit, not a hidden one.
 *   - Validation BEFORE the write. A receipt that breaks an invariant is never persisted, so the
 *     gate cannot run a tool on a decision the ledger would not accept.
 *   - An index, built once from the sink: chain tip, latest policy per agent, spend rows, and the
 *     set of call ids with a persisted ALLOW decision row (invariant 7).
 *   - A refusal to read a damaged file. A line that does not parse, or a chain that does not verify,
 *     makes every read THROW — which the gate turns into NOT_CHECKED. Skipping a bad line would let
 *     a lost policy or a lost spend row read as "nothing there".
 */
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateReceipt, verifyReceiptChain } from './receipt';
import type {
  ChainTip,
  KernelLedger,
  KernelReceipt,
  KernelSink,
  LedgerRecord,
  SignedOwnerPolicy,
} from './types';

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

/** Append-only JSONL. The directory is created on first write; nothing happens at import. */
export function createJsonlStore(path: string): KernelSink {
  return {
    async append(record) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(record) + '\n';
      // Open for append, write, flush to disk, close: a record that returned is a record that is there.
      const fh = await open(path, 'a', 0o600);
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
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const out: LedgerRecord[] = [];
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.trim() === '') return;
        try {
          out.push(JSON.parse(line) as LedgerRecord);
        } catch {
          // Never skip: a skipped line could be the policy that capped spending.
          throw new LedgerIntegrityError(`ledger line ${i + 1} is not valid JSON`);
        }
      });
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

  async appendReceipt(build: (tip: ChainTip | null) => KernelReceipt): Promise<KernelReceipt> {
    return this.locked(async () => {
      await this.ensureLoaded();
      const receipt = build(this.tip);
      const v = validateReceipt(receipt, { persisted_decision_ids: this.decisionIds });
      if (!v.ok) throw new ReceiptInvalidError([...new Set(v.errors.map((x) => x.code))]);
      const expectedPrev = this.tip?.receipt_hash ?? null;
      if (receipt.header.prev_hash !== expectedPrev) throw new ReceiptInvalidError(['broken_link']);
      await this.sink.append({ kind: 'receipt', receipt });
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
      await this.sink.append({ kind: 'policy', recorded_at: recordedAt, policy: signed });
      this.indexPolicy(signed);
    });
  }

  async latestPolicy(subject: string): Promise<SignedOwnerPolicy | null> {
    await this.ensureLoaded();
    return this.policies.get(subject) ?? null;
  }

  async spentTotals(q: { agent_id: string; policy_hash: string; since_s: number }): Promise<{ daily_raw: string; total_raw: string }> {
    await this.ensureLoaded();
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
}
