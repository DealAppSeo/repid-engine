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
import { HANDLED_SERVICE_TYPES, isHandledServiceType, directFulfillAllowed } from '../src/services/handled-service-types';

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

  // THIRD consumer: POST /contracts/:id/fulfill refuses a self-declared result
  // for any type that has a handler. If a handler is registered but its type is
  // missing from HANDLED_SERVICE_TYPES, the bypass silently re-opens for it.
  it('every registered handler has its service type listed in HANDLED_SERVICE_TYPES', () => {
    const expectedTypes: Record<string, string> = {
      VerificationServiceHandler: 'verification',
      CrossValidationServiceHandler: 'cross_validation',
      AnfisRoutingServiceHandler: 'anfis_routing',
      ReputationAuditServiceHandler: 'reputation_audit',
      StorageServiceHandler: 'decentralized_storage',
      SecurityAuditServiceHandler: 'security_audit',
      ZkpAuditServiceHandler: 'zkp_audit',
    };
    for (const handler of httpPath) {
      const type = expectedTypes[handler];
      expect(type).toBeDefined();
      expect(HANDLED_SERVICE_TYPES.has(type!)).toBe(true);
    }
    // and nothing is listed that has no handler
    expect(HANDLED_SERVICE_TYPES.size).toBe(httpPath.length);
  });
});

describe('direct-fulfil bypass', () => {
  it('recognises every handled type, case- and whitespace-insensitively', () => {
    expect(isHandledServiceType('verification')).toBe(true);
    expect(isHandledServiceType('  ZKP_Audit ')).toBe(true);
    expect(isHandledServiceType('security_audit')).toBe(true);
  });

  it('does NOT claim a type is handled when it is not', () => {
    // A type with no handler must remain directly fulfillable, or those
    // contracts become permanently undeliverable.
    expect(isHandledServiceType('fact_check')).toBe(false);
    expect(isHandledServiceType('')).toBe(false);
    expect(isHandledServiceType(null)).toBe(false);
    expect(isHandledServiceType(undefined)).toBe(false);
  });

  it('the escape hatch is OFF unless explicitly set to the exact string', () => {
    const prev = process.env['ALLOW_DIRECT_FULFILL'];
    try {
      delete process.env['ALLOW_DIRECT_FULFILL'];
      expect(directFulfillAllowed()).toBe(false);
      process.env['ALLOW_DIRECT_FULFILL'] = 'TRUE';   // a typo must not weaken it
      expect(directFulfillAllowed()).toBe(false);
      process.env['ALLOW_DIRECT_FULFILL'] = '1';
      expect(directFulfillAllowed()).toBe(false);
      process.env['ALLOW_DIRECT_FULFILL'] = 'true';
      expect(directFulfillAllowed()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['ALLOW_DIRECT_FULFILL'];
      else process.env['ALLOW_DIRECT_FULFILL'] = prev;
    }
  });
});
