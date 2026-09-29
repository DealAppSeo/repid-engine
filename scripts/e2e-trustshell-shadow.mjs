/**
 * TrustShell shadow check. GET only.
 * Exit 0 when the contract holds. Exit 2 when the base URL is missing.
 * Exit 1 when a route breaks the contract. No production write.
 */
const base = typeof process.env.STAGING_BASE_URL === 'string' ? process.env.STAGING_BASE_URL.trim() : '';
const sequence = process.env.E2E_HONESTY_SEQUENCE === '1';

if (!base) {
  console.error('NOT_CHECKED');
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function get(path) {
  const res = await fetch(base.replace(/\/$/, '') + path, { method: 'GET' });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function assertCountedRow(row) {
  if (!row || typeof row !== 'object') fail('honesty row missing');
  for (const key of ['family', 'host', 'TRUE', 'FALSE', 'NOT_CHECKED', 'first_pass']) {
    if (!(key in row)) fail('honesty row missing ' + key);
  }
  if (typeof row.family !== 'string' || row.family.length === 0) fail('honesty family');
  if (typeof row.host !== 'string' || row.host.length === 0) fail('honesty host');
  for (const key of ['TRUE', 'FALSE', 'NOT_CHECKED']) {
    if (typeof row[key] !== 'number') fail('honesty count');
  }
  const pass = row.first_pass;
  if (!pass || typeof pass !== 'object') fail('honesty first_pass');
  for (const key of ['TRUE', 'FALSE', 'NOT_CHECKED']) {
    if (typeof pass[key] !== 'number') fail('honesty first_pass count');
  }
  if (pass.TRUE === 0 && pass.FALSE === 0 && pass.NOT_CHECKED === 0) fail('honesty first_pass invented empty');
}

function assertHonestyShape(report, expect) {
  if (!report || report.status === 0 || report.rows === 0) fail('honesty invented 0');
  if (expect === 'rows') {
    if (report.status !== 'counted' || !Array.isArray(report.rows) || report.rows.length === 0) {
      fail('honesty rows were not counted');
    }
    assertCountedRow(report.rows[0]);
    return;
  }
  if (expect === 'empty') {
    if (report.status !== 'counted' || !Array.isArray(report.rows) || report.rows.length !== 0) {
      fail('empty honesty table was not counted');
    }
    return;
  }
  if (report.status !== 'NOT_CHECKED' || report.rows !== null) fail('missing honesty table was not NOT_CHECKED');
}

async function main() {
  const first = await get('/api/v1/hal/honesty-a');
  if (first.status !== 200) fail('honesty http ' + first.status);
  if (sequence) assertHonestyShape(first.body, 'rows');
  else if (first.body?.status === 'counted') {
    if (!Array.isArray(first.body.rows)) fail('counted honesty rows');
    if (first.body.rows.length > 0) assertCountedRow(first.body.rows[0]);
  } else {
    assertHonestyShape(first.body, 'missing');
  }

  const card = await get('/api/v1/after-create');
  if (card.status !== 200 || !card.body) fail('after-create http');
  if (card.body.can_verify !== true) fail('can_verify');
  if (card.body.can_stake !== false) fail('can_stake');
  if (typeof card.body.can_bind !== 'boolean') fail('can_bind');
  if (sequence && card.body.can_bind !== false) fail('can_bind followed a non-exact flag');
  const honestyCounted = first.body?.status === 'counted';
  if (card.body.can_rate_models !== honestyCounted) fail('can_rate_models');

  if (sequence) {
    const empty = await get('/api/v1/hal/honesty-a');
    assertHonestyShape(empty.body, 'empty');
  }

  const path = await get('/api/v1/human/path');
  if (path.status !== 200 || path.body?.applied !== false) fail('human path applied');
  if (!Array.isArray(path.body?.steps) || path.body.steps.length === 0) fail('human path steps');
  if (!path.body.steps.every((step) => step && step.applied === false)) fail('human path step applied');

  const spend = await get('/api/v1/human/spend/preview');
  if (spend.status !== 200 || !spend.body) fail('spend preview http');
  if (spend.body.applied !== false || spend.body.persisted !== false) fail('spend applied');
  if (!Array.isArray(spend.body.rates) || spend.body.rates[0] !== 50 || spend.body.rates[1] !== 100) {
    fail('spend rates');
  }

  if (sequence) {
    const missing = await get('/api/v1/hal/honesty-a');
    assertHonestyShape(missing.body, 'missing');
  }

  console.log('ok');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'request failed');
  process.exit(1);
});
