/**
 * The role migration's rollback, on a throwaway Postgres: forward twice, back once, forward again.
 * Nothing else ran the DOWN file before this. A skip here is NOT_CHECKED, never a pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';

const PG = process.env.T12_LANES_PG_URL;
const describePg = PG ? describe : describe.skip;
if (!PG) {
  // eslint-disable-next-line no-console
  console.warn('[t12-lane-rollback] NOT_CHECKED: needs T12_LANES_PG_URL (a throwaway Postgres).');
}

const FORWARD = readFileSync(join(__dirname, '../migrations/2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8');
const DOWN = readFileSync(join(__dirname, '../migrations/rollback/DOWN_2026-11-08_t12_lane_worker_role_DRAFT.sql'), 'utf8');
const FIXTURE = readFileSync(join(__dirname, 'fixtures/t12-lanes-schema.sql'), 'utf8');
const LANE_ROLES = ['t12_lane_maker', 't12_lane_checker', 't12_lane_integrator'];

describePg('the role migration rolls back cleanly', () => {
  const DB = 't12_rollback_test';
  let admin: Pool;

  const laneState = async () => {
    const q = async (sql: string) => (await admin.query(sql)).rows.map((r) => Object.values(r)[0] as string);
    return {
      policies: await q(`SELECT polname FROM pg_policy WHERE polname LIKE 't12_lane%' ORDER BY 1`),
      functions: await q(`SELECT proname FROM pg_proc WHERE proname LIKE 't12_belt%' ORDER BY 1`),
      loginRoles: await q(`SELECT rolname FROM pg_roles WHERE rolname LIKE 't12_lane%' AND rolcanlogin ORDER BY 1`),
      tableGrants: await q(`SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE grantee LIKE 't12_lane%' ORDER BY 1`),
    };
  };

  beforeAll(async () => {
    const root = new Client({ connectionString: PG });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${DB}`);
    await root.end();
    const u = new URL(PG!);
    u.pathname = `/${DB}`;
    admin = new Pool({ connectionString: u.toString() });
    await admin.query(FIXTURE);
    // A pre-existing definer function open to PUBLIC, and an app role that reaches it only through PUBLIC.
    await admin.query('CREATE OR REPLACE FUNCTION public.app_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 7 $$');
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 't12_rb_app') THEN CREATE ROLE t12_rb_app NOLOGIN; END IF; END $$`);
    await admin.query('GRANT USAGE ON SCHEMA public TO t12_rb_app');
  });

  afterAll(async () => {
    // Leave the cluster as the other lane tests expect it: roles present and able to log in.
    await admin.query(FORWARD);
    await admin.end();
  });

  it('forward is idempotent', async () => {
    await admin.query(FORWARD);
    const once = await laneState();
    await admin.query(FORWARD);
    expect(await laneState()).toEqual(once);
    expect(once.loginRoles).toEqual(LANE_ROLES.slice().sort());
    expect(once.policies).toEqual(['t12_lane_checker_pool', 't12_lane_claims', 't12_lane_halt', 't12_lane_integrator_pool', 't12_lane_maker_pool']);
    expect(once.functions.length).toBe(5);
  });

  it('back removes every lane policy, function and grant, and no other role loses access', async () => {
    const can = async () => (await admin.query(`SELECT has_function_privilege('t12_rb_app', 'public.app_definer()', 'EXECUTE') AS ok`)).rows[0].ok;
    expect(await can()).toBe(true);
    await admin.query(DOWN);
    const after = await laneState();
    expect(after).toEqual({ policies: [], functions: [], loginRoles: [], tableGrants: [] });
    expect(await can()).toBe(true);
    // Row security stays on: production had it on before the forward file.
    const rls = (await admin.query(`SELECT bool_and(relrowsecurity) AS on FROM pg_class WHERE relname IN ('trinity_tasks', 'agent_resource_claims', 'trinity_system_config')`)).rows[0].on;
    expect(rls).toBe(true);
  });

  it('forward again restores the fence after a rollback', async () => {
    await admin.query(FORWARD);
    const again = await laneState();
    expect(again.loginRoles).toEqual(LANE_ROLES.slice().sort());
    expect(again.policies.length).toBe(5);
    expect(again.functions.length).toBe(5);
  });
});
