import { db } from '../src/db';

async function run() {
  const { data } = await db.from('builders').select('*').eq('auth_method', 'token_only').order('created_at', { ascending: false }).limit(3);
  console.log(data);
  process.exit(0);
}
run();
