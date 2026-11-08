/**
 * t12-lane-profile.ts — what an ordinary lane worker may hold.
 *
 * A worker runs model-written code by design, so it is treated as compromisable. It gets a database
 * role scoped to the lane pool and free-model keys. It must not hold anything that signs, spends,
 * trades or administers. Measured 2026-11-08: the real CLI read none of those once its one engine
 * import was removed, so refusing to start with them costs nothing and closes the bypass.
 *
 * This is a boot refusal, not a filter: a worker launched with a privileged credential in its
 * environment has already been misconfigured, and stripping the variable would hide that.
 */
import { T12_ROUTES } from './t12-attempt';

/** Any credential-shaped name. A list of spellings fails open for each new one, so this matches the family. */
const CREDENTIAL_NAME = /(^|_)(KEY|KEYS|SECRET|SECRETS|TOKEN|PASSWORD|PASSWD|PAT|CREDS|CREDENTIALS|HMAC)(_|$)/;

/** The one exception to the family rule: the keys of routes whose accounts are not known to hold paid credit. */
const FREE_ROUTE_KEYS: ReadonlySet<string> = new Set(Object.values(T12_ROUTES).filter((r) => r.freeOnly).flatMap((r) => [...r.keyEnv]));

const PRIVILEGED: readonly RegExp[] = [
  /PRIVATE_KEY/,
  /(^|_)SIGNER_KEY$/,
  /^ERC8004_.*KEY/,
  /^EAS_.*KEY/,
  /^AGENT_KEY_MASTER$/,
  /^TRADING_CREDS/,
  /^(ALPACA|COINBASE|FIREBLOCKS|BINANCE|KRAKEN)_/,
  /^STRIPE_(SECRET|WEBHOOK|RESTRICTED)/,
  /^RAILWAY_(API_)?TOKEN$/,
  /^VERCEL_TOKEN$/,
  /^CLOUDFLARE_API_/,
  /^(GITHUB_TOKEN|GH_TOKEN|GH_PAT|LOOP_GH_PAT)$/,
  /^SUPABASE_(SERVICE|SECRET)/,
  /^SUPABASE_KEY$/,
  /^SUPABASE_DB_URL$/,
  /^(ADMIN_KEY|REPID_API_KEYS)$/,
  /ADMIN_KEY$/,
];

/** Only an integrator publishes, and publishing needs exactly this and nothing else from the list. */
const INTEGRATOR_MAY_HOLD: readonly RegExp[] = [/^(GITHUB_TOKEN|GH_TOKEN)$/];

/** Credential names present that this profile may not hold. Names only: a value is never read. */
export function privilegedEnvPresent(env: Record<string, string | undefined>, role: 'worker' | 'integrator' = 'worker'): string[] {
  return Object.keys(env)
    .filter((name) => !!env[name] && (PRIVILEGED.some((p) => p.test(name)) || (CREDENTIAL_NAME.test(name) && !FREE_ROUTE_KEYS.has(name))))
    .filter((name) => !(role === 'integrator' && INTEGRATOR_MAY_HOLD.some((p) => p.test(name))))
    .sort();
}

export interface DbPrivilege {
  name: string;
  privileged: boolean;
}

/** Is this connection able to go past row security? A worker's must not be. */
export async function dbPrivilege(db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }): Promise<DbPrivilege> {
  // Membership counts too: SET ROLE reaches a superuser role even from a NOINHERIT login.
  // So does owning a table: an owner skips its row policies unless they are forced, and a worker owns nothing.
  const { rows } = await db.query(
    `SELECT current_user AS name,
            EXISTS (SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) AND pg_has_role(current_user, r.oid, 'member'))
            OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('r', 'p') AND pg_has_role(current_user, c.relowner, 'member')) AS privileged`,
  );
  return { name: rows[0].name, privileged: !!rows[0].privileged };
}

/**
 * SECURITY DEFINER functions this connection can call, other than the belts. Each runs with its
 * owner's rights, and a function added after the migration starts out callable, so this is read live.
 */
export async function reachableDefiners(db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND p.proname !~ '^t12_belt_' AND n.nspname <> 'pg_catalog'
        AND has_schema_privilege(current_user, n.oid, 'USAGE') AND has_function_privilege(current_user, p.oid, 'EXECUTE')
      ORDER BY 1`,
  );
  return rows.map((r) => r.fn);
}
