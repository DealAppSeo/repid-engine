/**
 * The two service-handler registries must agree.
 *
 * There are two lists of handlers and nothing kept them in sync:
 *   src/routes/v1/agent.ts            — the HTTP path (POST /agent/process-contracts)
 *   src/workers/cascade-settlement-worker.ts — the server-side drain
 *
 * They drifted. `SecurityAuditServiceHandler` was registered in agent.ts on
 * 2026-07-27 and never added to the worker, so `security_audit` contracts never
 * drained server-side — they completed only if something happened to POST
 * /agent/process-contracts for that exact provider. Nothing errored; the
 * contracts just sat escrowed. It went unnoticed until an independent audit
 * diffed the two lists by eye.
 *
 * A half-registered service type is worse than an unregistered one: the
 * marketplace advertises it, a buyer escrows real money for it, and the work
 * silently never happens.
 *
 * This test reads both files as text rather than importing them, because
 * importing either drags in the whole engine (DB clients, workers, env).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

function registeredHandlers(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  return [...src.matchAll(/new\s+(\w*ServiceHandler)\s*\(\)/g)].map((m) => m[1]!).sort();
}

describe('service handler registry parity', () => {
  const httpPath = registeredHandlers('src/routes/v1/agent.ts');
  const workerPath = registeredHandlers('src/workers/cascade-settlement-worker.ts');

  it('registers at least the six known handlers on the HTTP path', () => {
    expect(httpPath.length).toBeGreaterThanOrEqual(6);
  });

  it('the worker registers EXACTLY the same handlers as the HTTP path', () => {
    // Fails loudly and names the offender, rather than leaving a service type
    // that drains through one path and not the other.
    expect(workerPath).toEqual(httpPath);
  });

  it('includes the handlers that were previously missing or unwired', () => {
    for (const required of ['SecurityAuditServiceHandler', 'ZkpAuditServiceHandler']) {
      expect(httpPath).toContain(required);
      expect(workerPath).toContain(required);
    }
  });
});
