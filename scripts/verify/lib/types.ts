/**
 * Cross-check harness — shared types.
 * A "check" re-derives a load-bearing claim from the DB/code and emits PASS/FAIL/SKIP.
 * The point: a report can't assert a number the harness contradicts.
 */
export type Status = 'PASS' | 'FAIL' | 'SKIP';

export interface CheckResult {
  /** stable id, e.g. 'authority' | 'f2-authz' | 'rls' | 'hal' | 'repid-guards' */
  id: string;
  title: string;
  status: Status;
  /** one-line human summary */
  summary: string;
  /** if true, a FAIL fails the whole suite (non-zero exit → blocks merge) */
  blocking: boolean;
  /** why a check SKIPped (e.g. 'needs provider keys') — never a silent pass */
  skipReason?: string;
  /** structured evidence (vectors, counts, confusion matrix) for the report JSON */
  detail?: Record<string, unknown>;
}

export type Check = () => Promise<CheckResult>;

export interface SuiteReport {
  generated_at: string;
  commit: string;
  branch: string;
  ok: boolean; // no blocking FAILs
  counts: { pass: number; fail: number; skip: number; blocking_fail: number };
  results: CheckResult[];
}

export const pass = (id: string, title: string, summary: string, blocking: boolean, detail?: Record<string, unknown>): CheckResult =>
  ({ id, title, status: 'PASS', summary, blocking, detail });
export const fail = (id: string, title: string, summary: string, blocking: boolean, detail?: Record<string, unknown>): CheckResult =>
  ({ id, title, status: 'FAIL', summary, blocking, detail });
export const skip = (id: string, title: string, skipReason: string, blocking: boolean, detail?: Record<string, unknown>): CheckResult =>
  ({ id, title, status: 'SKIP', summary: `skipped — ${skipReason}`, blocking, skipReason, detail });
