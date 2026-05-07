import { db } from '../src/db';

async function diag() {
  console.log('--- Query A: Recent Pending Jobs ---');
  const { data: a, error: errA } = await db
    .from('repid_proof_queue')
    .select('job_id, attempts, error_message, created_at, completed_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(10);
  if (errA) console.error(errA); else console.table(a);

  console.log('\n--- Query B: Attempted but Not Completed ---');
  const { data: b, error: errB } = await db
    .from('repid_proof_queue')
    .select('job_id, attempts, error_message, created_at')
    .gt('attempts', 0)
    .is('completed_at', null)
    .order('attempts', { ascending: false })
    .limit(20);
  if (errB) console.error(errB); else console.table(b);

  console.log('\n--- Query C: URL Distribution ---');
  const { data: c, error: errC } = await db
    .from('repid_proof_queue')
    .select('zkp_service_url')
    .eq('status', 'pending');
  if (errC) {
    console.error(errC);
  } else {
    const counts = (c || []).reduce((acc: any, row: any) => {
      acc[row.zkp_service_url] = (acc[row.zkp_service_url] || 0) + 1;
      return acc;
    }, {});
    console.table(Object.entries(counts).map(([url, count]) => ({ url, count })));
  }

  console.log('\n--- Query D: Error Message Distribution ---');
  const { data: d, error: errD } = await db
    .from('repid_proof_queue')
    .select('error_message');
  if (errD) {
    console.error(errD);
  } else {
    const errorCounts = (d || []).filter(r => r.error_message).reduce((acc: any, row: any) => {
      acc[row.error_message] = (acc[row.error_message] || 0) + 1;
      return acc;
    }, {});
    console.table(Object.entries(errorCounts).sort((a: any, b: any) => b[1] - a[1]).slice(0, 20).map(([error, count]) => ({ error, count })));
  }

  process.exit(0);
}

diag();
