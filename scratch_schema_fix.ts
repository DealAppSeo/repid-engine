import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const sqls = [
  // Drop the old tables that collide with the new required schema
  `DROP TABLE IF EXISTS repid_stakes CASCADE`,
  `DROP TABLE IF EXISTS repid_trade_attempts CASCADE`,
  
  // Extend repid_users if needed
  `CREATE TABLE IF NOT EXISTS repid_users (
    id uuid primary key default gen_random_uuid(),
    user_address text not null unique,
    display_name text,
    created_at timestamptz not null default now()
  )`,
  
  // Extend repid_agents
  `CREATE TABLE IF NOT EXISTS repid_agents (
    id uuid primary key default gen_random_uuid(),
    agent_id text not null unique,
    display_name text,
    repid_score integer not null default 100,
    repid_score_last_updated timestamptz,
    autonomous_cap integer,
    created_at timestamptz not null default now()
  )`,
  
  // Since repid_agents might already exist, try to add the missing columns just in case
  `ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS agent_id text unique`,
  `ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS display_name text`,
  `ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS repid_score integer not null default 100`,
  `ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS autonomous_cap integer`,
  `ALTER TABLE repid_agents ADD COLUMN IF NOT EXISTS repid_score_last_updated timestamptz`,
  
  // Recreate the new tables exactly as requested
  `CREATE TABLE repid_stakes (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references repid_users(id),
    agent_id uuid not null references repid_agents(id),
    stake_amount_usd numeric(18,2) not null check (stake_amount_usd > 0),
    status text not null check (status in ('active','withdrawn','expired')),
    created_at timestamptz not null default now(),
    withdrawn_at timestamptz
  )`,
  
  `CREATE TABLE repid_trade_attempts (
    id uuid primary key default gen_random_uuid(),
    agent_id uuid not null references repid_agents(id),
    user_id uuid not null references repid_users(id),
    stake_id uuid references repid_stakes(id),
    trade_size_usd numeric(18,2) not null,
    repid_at_decision integer not null,
    max_allowed_usd numeric(18,2) not null,
    fraction_used numeric(5,4) not null,
    decision text not null check (decision in ('approved','rejected_size','rejected_no_stake','rejected_repid_too_low')),
    reason text,
    executed boolean not null default false,
    executed_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  
  // Seed data
  `INSERT INTO repid_agents (agent_id, display_name, repid_score, autonomous_cap)
  VALUES 
    ('sophia', 'SOPHIA', 10000, 100000),
    ('veritas', 'VERITAS', 8500, 50000),
    ('hdm', 'HDM', 7200, 25000),
    ('test-newbie', 'Test Newbie', 100, 5000)
  ON CONFLICT (agent_id) DO UPDATE SET repid_score = EXCLUDED.repid_score, autonomous_cap = EXCLUDED.autonomous_cap`
];

async function run() {
    for (const sql of sqls) {
        console.log("Executing:", sql.substring(0, 50) + "...");
        const { error, data } = await supabase.rpc('exec_sql', { query: sql });
        if (error) {
            console.error("RPC ERROR:", error.message);
        } else {
            console.log("Success");
        }
    }
}

run().catch(console.error);
