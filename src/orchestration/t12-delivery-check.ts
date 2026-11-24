/**
 * Was the deliverable delivered, and do its copies agree? Read-only.
 *
 * A T12 agent answers twice: the reply stored in `trinity_tasks.result`, and whatever it saved to
 * `trinity_artifacts` for that task. On 2026-11-24, 16 of 17 replies judged "missing" had a good
 * artifact, and three times a reply and the same agent's own artifact disagreed on the facts. So
 * reading one copy can fail finished work, and can pass work whose two copies contradict each other.
 *
 * Every copy is held to the task's delivery contract: at least `min_lines` lines matching `pattern`
 * (the shape trinity-symphony-shared reads from metadata.delivery_contract). Copies that meet it are
 * then compared line for line.
 *
 * It proves the lines are present and whether the copies match. It says nothing about which copy is right.
 *
 * Caller: scripts/t12/delivery-check.ts. Nothing in the lane runner calls this.
 */
import vm from 'node:vm';
import { MAX_PATTERN_CHARS, specMeta, type DeliveryContract } from './t12-feed-order';

const MAX_TEXT_CHARS = 200_000;
const MATCH_TIMEOUT_MS = 250;
const MAX_DIFFERENCES = 10;

export type CopyState = 'delivered' | 'not_delivered' | 'empty' | 'not_checked';

export interface CopyReport {
  where: string;
  chars: number;
  state: CopyState;
  matched: number;
  reason?: string;
}

export interface DeliveryReport {
  task_id: string;
  status: string | null;
  contract: DeliveryContract | null;
  contract_source: string | null;
  reply: CopyReport;
  artifacts: CopyReport[];
  /** null: could not be judged. Never read null as "not delivered". */
  delivered_in_reply: boolean | null;
  delivered_in_artifact: boolean | null;
  /** true: two copies that each meet the contract differ. null: fewer than two copies meet it. */
  disagree: boolean | null;
  differences: Array<{ line: number; a: string; a_text: string | null; b: string; b_text: string | null }>;
  verdict: string;
}

function matchLines(where: string, text: string | null | undefined, contract: DeliveryContract | null): CopyReport & { lines: string[] } {
  const body = String(text ?? '');
  const base = { where, chars: body.length, matched: 0, lines: [] as string[] };
  if (!body.trim()) return { ...base, state: 'empty', reason: where === 'reply' ? 'the reply is empty' : 'the artifact has no content' };
  if (!contract) return { ...base, state: 'not_checked', reason: 'the task has no delivery contract' };
  try {
    // The pattern comes from a task row, so it runs under a time limit; pattern and text are data.
    const lines: string[] = JSON.parse(vm.runInNewContext(
      'const re = new RegExp(pattern); JSON.stringify(text.split(/\\r?\\n/).filter((l) => re.test(l)))',
      { pattern: contract.pattern, text: body.slice(0, MAX_TEXT_CHARS) }, { timeout: MATCH_TIMEOUT_MS },
    ));
    return lines.length >= contract.min_lines
      ? { ...base, state: 'delivered', matched: lines.length, lines }
      : { ...base, state: 'not_delivered', matched: lines.length, lines, reason: `matched ${lines.length} of ${contract.min_lines} required lines` };
  } catch (e) {
    const timedOut = (e as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
    return { ...base, state: 'not_checked', reason: timedOut ? 'contract_timeout' : 'contract_invalid: pattern is not a valid regular expression' };
  }
}

/** Some copy met the contract: true. None did and every copy was judged: false. Otherwise null. */
function delivered(copies: readonly CopyReport[]): boolean | null {
  if (copies.some((c) => c.state === 'delivered')) return true;
  return copies.some((c) => c.state === 'not_checked') ? null : false;
}

// ponytail: line-for-line after squeezing spaces; a copy that is only formatted differently
// (a bullet, a table border) reads as a disagreement. The differing lines are returned so a person can tell.
const squeeze = (l: string) => l.trim().replace(/\s+/g, ' ');

export function deliveryReport(input: {
  taskId: string | number;
  status?: string | null;
  reply: string | null | undefined;
  artifacts: ReadonlyArray<{ id: string | number; content: string | null | undefined }>;
  contract: DeliveryContract | null;
  contractSource?: string | null;
}): DeliveryReport {
  const reply = matchLines('reply', input.reply, input.contract);
  const artifacts = input.artifacts.map((a) => matchLines(`artifact ${a.id}`, a.content, input.contract));
  const good = [reply, ...artifacts].filter((c) => c.state === 'delivered');
  const differences: DeliveryReport['differences'] = [];
  const first = good[0];
  for (const other of good.slice(1)) {
    if (!first) break;
    for (let i = 0; i < Math.max(first.lines.length, other.lines.length); i++) {
      const a = first.lines[i] ?? null;
      const b = other.lines[i] ?? null;
      if ((a === null ? null : squeeze(a)) !== (b === null ? null : squeeze(b)) && differences.length < MAX_DIFFERENCES) {
        differences.push({ line: i + 1, a: first.where, a_text: a, b: other.where, b_text: b });
      }
    }
  }
  const strip = ({ lines: _lines, ...c }: CopyReport & { lines: string[] }): CopyReport => c;
  const inReply = input.contract ? delivered([reply]) : null;
  const inArtifact = input.contract ? delivered(artifacts) : null;
  const disagree = good.length < 2 ? null : differences.length > 0;
  const verdict = !input.contract ? 'NOT_CHECKED: the task has no delivery contract, so nothing can be shown delivered'
    : disagree ? `DISAGREE: ${good.length} copies meet the contract and differ, first at line ${differences[0]?.line}`
    : inReply || inArtifact ? `DELIVERED in ${[inReply && 'the reply', inArtifact && 'an artifact'].filter(Boolean).join(' and ')}${disagree === false ? '; the copies match' : ''}`
    : inReply === false && inArtifact === false ? 'NOT_DELIVERED: neither the reply nor any artifact meets the contract'
    : 'NOT_CHECKED: a copy could not be judged, and no copy meets the contract';
  return {
    task_id: String(input.taskId), status: input.status ?? null, contract: input.contract, contract_source: input.contract ? input.contractSource ?? null : null,
    reply: strip(reply), artifacts: artifacts.map(strip), delivered_in_reply: inReply, delivered_in_artifact: inArtifact, disagree, differences, verdict,
  };
}

/** A contract object as stored on a task row, or null when it cannot be used. */
function contractFrom(c: unknown): DeliveryContract | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const { pattern, min_lines } = c as { pattern?: unknown; min_lines?: unknown };
  const min = min_lines === undefined ? 1 : Number(min_lines);
  if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_CHARS || !Number.isInteger(min) || min < 1) return null;
  return { pattern, min_lines: min };
}

export interface ReadDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

/**
 * Read one task's reply and every artifact saved under its id, then report. Two SELECTs, nothing else.
 * `trinity_artifacts.task_id` is text and `trinity_tasks.id` is bigint [V information_schema 2026-11-24],
 * so the id is passed as text to the artifact read.
 */
export async function readDelivery(db: ReadDb, taskId: string | number, override?: DeliveryContract | null): Promise<DeliveryReport> {
  const id = String(taskId);
  if (!/^\d{1,18}$/.test(id)) throw new Error(`task id must be a number, got ${id}`);
  const { rows } = await db.query('SELECT id, status, result, metadata FROM trinity_tasks WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error(`task ${id} was not found`);
  let md = rows[0].metadata;
  if (typeof md === 'string') {
    try { md = JSON.parse(md); } catch { md = null; }
  }
  const fromRow = contractFrom(md?.delivery_contract);
  const fromSpec = specMeta(md?.t12?.spec?.context).meta.deliveryContract ?? null;
  const contract = override ?? fromRow ?? fromSpec;
  const contractSource = override ? 'argument' : fromRow ? 'metadata.delivery_contract' : fromSpec ? 'spec context meta' : null;
  const { rows: artifacts } = await db.query('SELECT id, content FROM trinity_artifacts WHERE task_id = $1 ORDER BY id', [id]);
  return deliveryReport({ taskId: id, status: rows[0].status, reply: rows[0].result, artifacts, contract, contractSource });
}
