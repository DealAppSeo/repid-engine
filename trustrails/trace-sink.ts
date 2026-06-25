/**
 * TrustRails decision-trace sink (Phase 3) — LOCAL JSON only.
 * Persists each guard() DecisionTrace as one JSON object per line. No network, no DB.
 */
import * as fs from 'fs';
import * as path from 'path';
import { type DecisionTrace } from './guard';

/** Default local sink: ./.trustrails-traces/decisions.jsonl (gitignored). */
export function defaultTracePath(cwd: string = process.cwd()): string {
  return path.join(cwd, '.trustrails-traces', 'decisions.jsonl');
}

/**
 * Build a synchronous file sink for guard()'s `sink` option. Appends one JSON line per
 * decision. Best-effort: creates the directory, never throws (a logging failure must
 * never affect a gate decision).
 */
export function fileTraceSink(filePath: string = defaultTracePath()): (t: DecisionTrace) => void {
  return (trace: DecisionTrace): void => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(trace) + '\n', 'utf8');
    } catch {
      /* never throw from the trace sink */
    }
  };
}

/** Read traces back (for review tooling / tests). Returns [] if the file is absent. */
export function readTraces(filePath: string = defaultTracePath()): DecisionTrace[] {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DecisionTrace);
  } catch {
    return [];
  }
}
