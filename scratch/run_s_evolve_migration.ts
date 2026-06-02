import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const sqlPath = path.join(__dirname, '../migrations/2026-06-02-s-evolve-functions.sql');
  console.log('Reading migration file:', sqlPath);
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('Executing migration...');
  const { data, error } = await supabase.rpc('run_sql', { sql });
  if (error) {
    console.error('Migration failed:', error);
  } else {
    console.log('Migration succeeded. Result:', data);
  }
}

main().catch(console.error);
