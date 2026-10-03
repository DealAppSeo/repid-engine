/**
 * T12 free-wave selector. Default off. Does not start a swarm and does not call a host.
 * Heartbeat stays a SQL write. This module does not replace it.
 * On only when T12_FREE_WAVE is the exact string true. Order is local, then groq, then
 * cerebras. Local joins only when LOCAL_LLM_BASE_URL is a loopback host (127.0.0.1,
 * localhost, ::1); a remote base is never "local" and is skipped. t12Wave walks that
 * order through a caller-supplied attempt and STOPS THE WAVE ON A 429: a rate limit is
 * a signal to back off, not to spray the next host (llm_call_log 2026-09-06 and 09-23 show
 * the burst that cascading through providers produces). Any other failure tries the next
 * host. Nothing answered is NOT_CHECKED.
 * One task claims one queue row, or one local fixture when the queue is empty,
 * runs scripts/sim-hal-traps.mjs, and writes pass, fail, or NOT_CHECKED.
 * The belt names trustshell status. This fixture runs the local script so the
 * check does not open a connection. A miss, including 0, is NOT_CHECKED.
 * This module does not assign T12_FREE_WAVE.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const T12_FREE_WAVE_ORDER = ['groq', 'cerebras'] as const;
/** The local host name in the order. Present only when a loopback base is configured. */
export const T12_LOCAL_HOST = 'local';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Local stand-in for the belt command `trustshell status`. */
export const T12_HAL_TRAPS_SCRIPT = 'scripts/sim-hal-traps.mjs';

export type T12TaskResult = 'pass' | 'fail' | 'NOT_CHECKED';

export interface T12TaskRow {
  id: string;
  claimed_at?: string | null;
  claimed_by?: string | null;
  result?: T12TaskResult;
}

export function t12FreeWaveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env === process.env ? process.env.T12_FREE_WAVE : env.T12_FREE_WAVE;
  return raw === 'true';
}

/** LOCAL_LLM_BASE_URL when it is http(s) on a loopback host with no userinfo; else null. */
export function t12LocalBase(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env === process.env ? process.env.LOCAL_LLM_BASE_URL : env.LOCAL_LLM_BASE_URL)?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return LOOPBACK.has(url.hostname) ? url.toString() : null;
}

export function t12FreeWaveOrder(env: Record<string, string | undefined> = process.env): readonly string[] {
  if (!t12FreeWaveEnabled(env)) return [];
  return t12LocalBase(env) ? [T12_LOCAL_HOST, ...T12_FREE_WAVE_ORDER] : T12_FREE_WAVE_ORDER;
}

export type T12WaveOutcome = 'answered' | 'rate_limited' | 'NOT_CHECKED';

export interface T12WaveResult {
  outcome: T12WaveOutcome;
  /** The host that answered, or the host whose 429 stopped the wave. */
  host: string | null;
  tried: string[];
}

/**
 * Try each host in order until one answers (2xx). A 429 stops the wave on that host: no
 * further host is tried. A thrown attempt or any other status tries the next host. Off, an
 * empty order, or every host failing is NOT_CHECKED. The attempt is the caller's: this
 * module opens no connection and holds no key (a local host must get none).
 */
export async function t12Wave(input: {
  env?: Record<string, string | undefined>;
  attempt: (host: string) => Promise<{ status: number }>;
}): Promise<T12WaveResult> {
  const order = t12FreeWaveOrder(input.env ?? {});
  const tried: string[] = [];
  for (const host of order) {
    tried.push(host);
    let status: number | null = null;
    try {
      const res = await input.attempt(host);
      status = typeof res?.status === 'number' ? res.status : null;
    } catch {
      status = null;
    }
    if (status === 429) return { outcome: 'rate_limited', host, tried };
    if (status !== null && status >= 200 && status < 300) return { outcome: 'answered', host, tried };
  }
  return { outcome: 'NOT_CHECKED', host: null, tried };
}

/** pass, fail, or NOT_CHECKED. The number 0 and the string "0" are a miss. */
export function t12ResultFromCheck(value: unknown): T12TaskResult {
  if (value === 'pass' || value === 'fail' || value === 'NOT_CHECKED') return value;
  return 'NOT_CHECKED';
}

export function t12LocalFixture(): T12TaskRow {
  return { id: 't12-local-fixture' };
}

function claimRow(row: T12TaskRow, now: string): void {
  if (typeof row.claimed_at !== 'string' || row.claimed_at.length === 0) row.claimed_at = now;
  if (typeof row.claimed_by !== 'string' || row.claimed_by.length === 0) row.claimed_by = 't12-free-wave';
}

export function t12RunHalTraps(): T12TaskResult {
  const script = path.join(__dirname, '..', '..', T12_HAL_TRAPS_SCRIPT);
  try {
    const out = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    if (out.trim() === '0') return 'NOT_CHECKED';
    return 'pass';
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status !== 0) return 'fail';
    return 'NOT_CHECKED';
  }
}

export function t12OneTask(input: {
  env?: Record<string, string | undefined>;
  queue?: T12TaskRow[] | null;
  now?: string;
  check?: () => unknown;
} = {}): { claimed: boolean; ran: boolean; order: readonly string[]; row: T12TaskRow | null } {
  const env = input.env ?? {};
  if (!t12FreeWaveEnabled(env)) return { claimed: false, ran: false, order: [], row: null };
  const queued = input.queue;
  const head = queued && queued.length > 0 ? queued[0] : undefined;
  const row: T12TaskRow = head ?? t12LocalFixture();
  const now = typeof input.now === 'string' && input.now.length > 0 ? input.now : 'claimed';
  claimRow(row, now);
  let raw: unknown;
  try {
    raw = (input.check ?? t12RunHalTraps)();
  } catch {
    raw = 'NOT_CHECKED';
  }
  row.result = t12ResultFromCheck(raw);
  return { claimed: true, ran: true, order: t12FreeWaveOrder(env), row };
}
