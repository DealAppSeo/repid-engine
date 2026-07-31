/**
 * DATABASE_URL candidate checker (2026-07-31).
 *
 * Try a candidate Supabase connection string and get a clear PASS/FAIL, without
 * the password ever reaching a log, a transcript, or an assistant. Useful when
 * testing saved password candidates one at a time.
 *
 * The password is NEVER printed. Output shows only user / host / port / db and
 * a verdict, so this is safe to run with output shared.
 *
 * Run (PowerShell):
 *   $env:DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres"
 *   npx ts-node --transpile-only scripts/cc-check-db-url.ts
 *
 * Or put DATABASE_URL in .env.master / .env and run it the same way.
 */
import { Client } from 'pg';

function describeMasked(raw: string): string {
  try {
    const u = new URL(raw);
    return `user=${u.username} host=${u.hostname} port=${u.port || '(default)'} db=${u.pathname.replace(/^\//, '') || '(none)'} pwLen=${u.password ? u.password.length : 0}`;
  } catch {
    return '(unparseable URL — check the scheme is postgresql:// and that special characters in the password are percent-encoded)';
  }
}

/**
 * Build a connection string from parts, percent-encoding the password for you.
 * This removes the single most common false negative: a CORRECT password that
 * contains @ : / ? # [ ] fails auth when pasted raw into a URI, and looks
 * identical to a wrong password. Set DB_PASSWORD and let this do the escaping.
 */
function fromParts(): string | null {
  const pw = process.env.DB_PASSWORD;
  if (!pw) return null;
  const ref = process.env.DB_REF || 'qnnpjhlxljtqyigedwkb';
  const mode = (process.env.DB_MODE || 'shared').toLowerCase(); // 'shared' | 'dedicated'
  const host =
    process.env.DB_HOST ||
    (mode === 'dedicated'
      ? `db.${ref}.supabase.co`
      : `aws-0-${process.env.DB_REGION || 'us-west-1'}.pooler.supabase.com`);
  const user = process.env.DB_USER || (mode === 'dedicated' ? 'postgres' : `postgres.${ref}`);
  const port = process.env.DB_PORT || '6543';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@${host}:${port}/${process.env.DB_NAME || 'postgres'}`;
}

async function main() {
  const raw = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || fromParts() || '';
  if (!raw) {
    console.error('FAIL: set DATABASE_URL, or set DB_PASSWORD (+ optional DB_MODE=shared|dedicated) and let this script build + encode the URL.');
    process.exitCode = 1;
    return;
  }

  console.log(`checking: ${describeMasked(raw)}`);

  // Sanity checks that catch the two classic mistakes before we even dial out.
  try {
    const u = new URL(raw);
    if (u.port === '5432' && u.hostname.includes('pooler')) {
      console.warn('WARN: port 5432 on a pooler host is the SESSION pooler. direct-pg requires the TRANSACTION pooler (port 6543).');
    }
    if (u.hostname.includes('pooler') && !u.username.includes('.')) {
      console.warn('WARN: pooler usernames are normally "postgres.<project-ref>". A bare "postgres" user usually fails against the pooler.');
    }
  } catch { /* described above */ }

  const client = new Client({ connectionString: raw, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const r = await client.query('select current_user, current_database(), version()');
    const row: any = r.rows[0] ?? {};
    console.log('PASS: connected and queried successfully.');
    console.log(`  current_user=${row.current_user} database=${row.current_database}`);
    console.log(`  server=${String(row.version || '').split(' ').slice(0, 2).join(' ')}`);
    console.log('\nThis string is valid — safe to set as DATABASE_URL on Railway.');
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.error(`FAIL: ${msg}`);
    if (/password authentication failed|SASL|SCRAM/i.test(msg)) {
      console.error('  → wrong password (or the password needs percent-encoding: @ : / ? # [ ] must be escaped).');
    } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
      console.error('  → host not found; check the region in the hostname.');
    } else if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
      console.error('  → could not reach the host/port; check port 6543 and any network restrictions.');
    } else if (/does not exist/i.test(msg)) {
      console.error('  → user or database name is wrong (pooler user is normally postgres.<project-ref>).');
    }
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('FAIL (unexpected):', e?.message ?? e);
  process.exitCode = 1;
});
