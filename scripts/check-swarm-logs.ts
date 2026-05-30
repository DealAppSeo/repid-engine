import { getDb } from './liveness-probes/_shared';

async function main() {
  const db = getDb();
  const { count, error } = await db
    .from('anfis_routing_logs')
    .select('id', { count: 'exact', head: true });

  if (error) console.error(error);
  else console.log('Total anfis_routing_logs:', count);
}

main().catch(console.error);
