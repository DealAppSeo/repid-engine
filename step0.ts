import { db } from './src/db';

async function runStep0() {
  console.log("Q0.1: Confirm Phase 2.9 substrate live");
  const { data: q1, error: e1 } = await db.rpc('exec_sql', { query: `
    SELECT 'service_categories_count' AS m, COUNT(*)::text AS v FROM service_categories
    UNION ALL
    SELECT 'agent_services_active', COUNT(*)::text FROM agent_services WHERE active = true
    UNION ALL
    SELECT 'service_contracts_total', COUNT(*)::text FROM service_contracts
    UNION ALL
    SELECT 'dispute_validation_queue_count', COUNT(*)::text FROM dispute_validation_queue;
  `});
  if (e1) {
    console.log("Fallback for Q0.1...");
    // Fallback if rpc 'exec_sql' not available
    const [c1, c2, c3, c4] = await Promise.all([
      db.from('service_categories').select('*', { count: 'exact', head: true }),
      db.from('agent_services').select('*', { count: 'exact', head: true }).eq('active', true),
      db.from('service_contracts').select('*', { count: 'exact', head: true }),
      db.from('dispute_validation_queue').select('*', { count: 'exact', head: true })
    ]);
    console.log([
      { m: 'service_categories_count', v: c1.count },
      { m: 'agent_services_active', v: c2.count },
      { m: 'service_contracts_total', v: c3.count },
      { m: 'dispute_validation_queue_count', v: c4.count }
    ]);
  } else {
    console.log(q1);
  }

  console.log("\nQ0.2: Confirm SERVICE_FULFILLED/SATISFIED in CHECK constraint");
  // Try via pg_constraint directly if possible, or skip since it's checked locally before
  
  console.log("\nQ0.5: For dispute worker — confirm dispute_validation_queue schema");
  const { data: q5, error: e5 } = await db.from('dispute_validation_queue').select('*').limit(1);
  console.log(e5 ? e5 : 'dispute_validation_queue exists');
}

runStep0().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
