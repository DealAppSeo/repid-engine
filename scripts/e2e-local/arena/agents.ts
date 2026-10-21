/**
 * The arena's agents are an INJECTED interface. Nothing here holds a key, calls a model or reads an
 * environment variable: a stub answers in tests, and the loop (outside this repo, E:\dev\ops\loop\
 * arena-loop.mjs) supplies an HTTP-backed implementation that asks free LLMs. A model proposes terms
 * and deliverables as JSON; CODE validates that JSON and decides everything (spec §6).
 *
 * A model that errors, times out or answers something unparseable throws ModelError. The runner turns
 * that into NOT_CHECKED, never into a verdict (rule 24).
 */
import type { Sym } from './oracle';

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface Terms {
  asset: Sym;
  amount_raw: string;
  work_statement: string;
  acceptance_criteria: string[];
  /** The seller's answer to the buyer's offer. Ignored on the buyer's own proposal. */
  accept?: boolean;
}

export interface TermsContext {
  role: 'buyer' | 'seller';
  case_id: string;
  service_request: string;
  /** Public limits the agent is told about. The agent is not trusted to respect them. */
  limits: Record<Sym, { decimals: number; per_tx_max_raw: string }>;
  /** The asset and ceiling this exchange is about. */
  asset: Sym;
  offer?: Terms;
}

export interface DeliverContext {
  terms: Terms;
  service_hash: string;
}
export interface Delivery {
  text: string;
}
export interface JudgeContext {
  terms: Terms;
  delivery: Delivery;
}
export interface JudgeNote {
  satisfied: boolean;
  note: string;
}

export interface ArenaAgents {
  proposeTerms(ctx: TermsContext): Promise<Terms>;
  deliver(ctx: DeliverContext): Promise<Delivery>;
  judge(ctx: JudgeContext): Promise<JudgeNote>;
  /** Which models answered so far (frozen into the evidence). */
  modelIds?(): string[];
}

const CANONICAL_UINT = /^[1-9][0-9]*$/;

/** Code decides what a model's terms are worth: anything outside this shape is not a proposal. */
export function validateTerms(t: unknown, perTxMaxRaw: string, asset: Sym): { ok: true; terms: Terms } | { ok: false; why: string } {
  const x = t as Partial<Terms> | null;
  if (!x || typeof x !== 'object') return { ok: false, why: 'terms are not an object' };
  if (x.asset !== asset) return { ok: false, why: `asset must be ${asset}` };
  if (typeof x.amount_raw !== 'string' || !CANONICAL_UINT.test(x.amount_raw)) return { ok: false, why: 'amount_raw must be a positive decimal-integer string' };
  if (BigInt(x.amount_raw) > BigInt(perTxMaxRaw)) return { ok: false, why: 'amount_raw is above the per-transaction cap' };
  if (typeof x.work_statement !== 'string' || x.work_statement.length < 5 || x.work_statement.length > 400) return { ok: false, why: 'work_statement must be 5-400 characters' };
  const c = x.acceptance_criteria;
  if (!Array.isArray(c) || c.length < 1 || c.length > 4 || c.some((s) => typeof s !== 'string' || s.length < 3 || s.length > 160)) return { ok: false, why: 'acceptance_criteria must be 1-4 strings of 3-160 characters' };
  return { ok: true, terms: { asset, amount_raw: x.amount_raw, work_statement: x.work_statement, acceptance_criteria: c, accept: x.accept === true } };
}

/** Deterministic acceptance: structural only. The judge model's opinion is advisory and never reaches this. */
export function acceptDelivery(d: unknown): boolean {
  const text = (d as Delivery | null)?.text;
  return typeof text === 'string' && text.trim().length >= 20 && text.length <= 4000;
}

/** A deterministic stand-in for tests: no model, no network, no randomness. */
export class StubAgents implements ArenaAgents {
  calls = { proposeTerms: 0, deliver: 0, judge: 0 };
  constructor(
    private o: { amount_raw?: Partial<Record<Sym, string>>; sellerAccepts?: boolean; deliveryText?: string; judgeSatisfied?: boolean; fail?: 'proposeTerms' | 'deliver' | 'judge' } = {},
  ) {}

  async proposeTerms(ctx: TermsContext): Promise<Terms> {
    this.calls.proposeTerms++;
    if (this.o.fail === 'proposeTerms') throw new ModelError('stub: model unavailable');
    const amount = this.o.amount_raw?.[ctx.asset] ?? (ctx.asset === 'USDC' ? '250000' : '100000000000000');
    return {
      asset: ctx.asset,
      amount_raw: amount,
      work_statement: `Summarise the public README of project ${ctx.case_id} in five bullet points.`,
      acceptance_criteria: ['five bullet points', 'no invented facts'],
      accept: ctx.role === 'seller' ? this.o.sellerAccepts !== false : undefined,
    };
  }

  async deliver(): Promise<Delivery> {
    this.calls.deliver++;
    if (this.o.fail === 'deliver') throw new ModelError('stub: model unavailable');
    return { text: this.o.deliveryText ?? '- one\n- two\n- three\n- four\n- five (synthetic L0 deliverable)' };
  }

  async judge(): Promise<JudgeNote> {
    this.calls.judge++;
    if (this.o.fail === 'judge') throw new ModelError('stub: model unavailable');
    return { satisfied: this.o.judgeSatisfied !== false, note: 'stub judge (advisory only)' };
  }

  modelIds() {
    return ['stub'];
  }
}

/**
 * Agents served over loopback HTTP by the loop, which owns the model keys and the daily call cap.
 * Only a local URL is ever used (the arena's egress tripwire would throw otherwise).
 */
export class HttpAgents implements ArenaAgents {
  private models = new Set<string>();
  constructor(private url: string, private token: string) {}

  private async call<T>(method: string, ctx: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-token': this.token }, body: JSON.stringify({ method, ctx }) });
    } catch (e) {
      throw new ModelError(`agent bridge unreachable: ${String((e as Error).message).slice(0, 80)}`);
    }
    const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: string; model?: string } | null;
    if (!j || !j.ok || j.result === undefined) throw new ModelError(j?.error ?? `agent bridge answered ${res.status}`);
    if (j.model) this.models.add(j.model);
    return j.result;
  }

  proposeTerms = (ctx: TermsContext) => this.call<Terms>('proposeTerms', ctx);
  deliver = (ctx: DeliverContext) => this.call<Delivery>('deliver', ctx);
  judge = (ctx: JudgeContext) => this.call<JudgeNote>('judge', ctx);
  modelIds = () => [...this.models];
}
