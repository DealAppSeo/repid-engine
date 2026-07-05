/**
 * OUTPUT_PATH: scripts/_load-env-master.ts
 * Side-effect module: loads real Supabase credentials from .env.master BEFORE any module
 * that reads process.env at import time (e.g. src/config.ts) evaluates. Import this FIRST.
 * Read-only: does not print secret values, only the resolved path.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const explicit = process.env.ENV_MASTER_PATH;
const candidates = [
  explicit,
  path.resolve(process.cwd(), '../.env.master'),
  path.resolve(process.cwd(), '../../.env.master'),
  'C:/Users/Cash4/repos/.env.master',
].filter(Boolean) as string[];

let loaded = false;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    dotenv.config({ path: c, quiet: true });
    // eslint-disable-next-line no-console
    console.error(`[phase0] loaded env from ${c}`);
    loaded = true;
    break;
  }
}
if (!loaded) {
  dotenv.config({ quiet: true });
  // eslint-disable-next-line no-console
  console.error('[phase0] .env.master not found; fell back to default dotenv');
}
