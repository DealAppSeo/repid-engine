/**
 * The service types that have a real handler.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The handler list existed twice (src/routes/v1/agent.ts and
 * src/workers/cascade-settlement-worker.ts) and drifted — `security_audit` was
 * registered in one and not the other for weeks, so those contracts silently
 * never drained server-side.
 *
 * A THIRD consumer now needs the same knowledge: `POST /contracts/:id/fulfill`
 * has to know whether a service type is supposed to be delivered by a handler,
 * so it can refuse a provider that tries to self-declare the result instead.
 * Importing either registry from a route would drag the whole engine (DB
 * clients, workers, env) into the request path, so the knowledge lives here as
 * plain data and the registries are checked against it by a test.
 *
 * IF YOU ADD A HANDLER, ADD ITS TYPE HERE TOO. The parity test fails otherwise.
 */

/**
 * Service types delivered by a registered handler. For these, the deliverable
 * MUST come from the handler path — which runs the PCP/HAL verdict gate — and
 * never from a provider POSTing its own `result`.
 */
export const HANDLED_SERVICE_TYPES: ReadonlySet<string> = new Set([
  'verification',
  'cross_validation',
  'anfis_routing',
  'reputation_audit',
  'decentralized_storage',
  'security_audit',
  'zkp_audit',
]);

export function isHandledServiceType(serviceType: string | null | undefined): boolean {
  if (!serviceType) return false;
  return HANDLED_SERVICE_TYPES.has(serviceType.trim().toLowerCase());
}

/**
 * The escape hatch for direct fulfilment, and the reason it is loud.
 *
 * Some service types genuinely have no handler yet; those contracts would be
 * unfulfillable without a direct path. `ALLOW_DIRECT_FULFILL=true` also permits
 * it for HANDLED types, which is a real weakening — it re-opens the bypass — so
 * every use is logged with the contract id rather than passing silently.
 */
export function directFulfillAllowed(): boolean {
  return process.env['ALLOW_DIRECT_FULFILL'] === 'true';
}
