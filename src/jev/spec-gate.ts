/**
 * Local spec gate. A ticket names the paths a diff may touch.
 * Missing input is not checked. A path outside the ticket fails the gate.
 * Scope only: the words in the ticket are not scored, and nothing is fetched.
 */

export interface JevSpecTicket {
  id?: string | null;
  paths?: readonly string[] | null;
}

export interface JevDiffStat {
  files?: readonly string[] | null;
  insertions?: number | null;
  deletions?: number | null;
}

export interface JevSpecGateInput {
  ticket?: JevSpecTicket | null;
  diffStat?: JevDiffStat | null;
}

export type JevSpecReason = 'in_spec' | 'not_checked' | 'path_outside_ticket';

export interface JevSpecGateResult {
  ok: boolean;
  reason: JevSpecReason;
}

function norm(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function listed(values: readonly string[] | null | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const cleaned = norm(value);
    if (!cleaned) return null;
    out.push(cleaned);
  }
  return out;
}

function covers(file: string, allowed: readonly string[]): boolean {
  return allowed.some((path) => file === path || file.startsWith(path + '/'));
}

export function jevSpecGate(input: JevSpecGateInput): JevSpecGateResult {
  const ticket = input.ticket;
  const id = typeof ticket?.id === 'string' ? ticket.id.trim() : '';
  const paths = listed(ticket?.paths);
  const files = listed(input.diffStat?.files);
  if (!id || !paths || !files) {
    return { ok: false, reason: 'not_checked' };
  }
  if (files.some((file) => !covers(file, paths))) {
    return { ok: false, reason: 'path_outside_ticket' };
  }
  return { ok: true, reason: 'in_spec' };
}
