import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config, LOCAL_MODE } from './config';
import { createLocalStore } from './selfhost/local-store';

// DATA-LOCAL RESOLUTION. In LOCAL_MODE, `db` is a supabase-js-SHAPED adapter over a
// LOCAL persistent store (SQLite file, or a JSON file if no driver) — so the score
// path completes on the operator's own box with zero data egress. When LOCAL_MODE
// is off, behavior is byte-for-byte unchanged: the hosted supabase-js client. Every
// consumer keeps importing `{ db }` and calling `.from(table)...` — the shape is the
// contract, the backend is the switch. See src/selfhost/local-store.ts.
export const db: SupabaseClient = LOCAL_MODE
  ? (createLocalStore(process.env.LOCAL_STORE_PATH) as unknown as SupabaseClient)
  : createClient(config.supabaseUrl, config.supabaseKey);
