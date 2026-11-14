/**
 * jest setupFiles entry: no unit test reaches a database to read a circuit breaker.
 *
 * src/middleware/circuit-breaker.ts reads `repid_config` with its own client and FAILS CLOSED when
 * the read fails. Since 2026-11-14 the score, proof and trade writers check it, so without this every
 * unit test of those writers would be refused (CI's SUPABASE_URL is a dead localhost), or would depend
 * on the network. Here every switch reads closed, like the production default rows. A test of a
 * tripped switch installs its own read with `__setBreakerRead`.
 *
 * Set through the global the module reads, not by importing it: importing it loads src/config.ts,
 * which throws without SUPABASE_URL, in every suite. RUN_INTEGRATION=1 reads the real table
 * (tests/helpers/run-integration.ts).
 */
if (process.env.RUN_INTEGRATION !== '1') {
  (globalThis as any)[Symbol.for('repid-engine.circuit-breaker.read')] = async () => ({
    data: { value: 'false' },
    error: null,
  });
}

export {};
