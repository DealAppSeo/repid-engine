/**
 * PROTECTED (trap-001). The candidate-side half of the oracle: import src/budget.mjs, evaluate the
 * cases read from stdin, print exactly one result line. Runs under --permission with read access to
 * src/ and this file only (see oracle-client.mjs). Values are tagged the same way as the client's.
 */
const MARK = 'XC1-ORACLE-RESULT ';
const write = process.stdout.write.bind(process.stdout); // captured before candidate code loads

function decode(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('$num' in v) return v.$num === '-0' ? -0 : Number(v.$num);
    if ('$big' in v) return BigInt(v.$big);
    if ('$undef' in v) return undefined;
  }
  return v;
}
function encode(v) {
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return { $num: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'bigint') return { $big: String(v) };
  if (v === undefined) return { $undef: true };
  if (typeof v === 'function' || typeof v === 'symbol') return { $type: typeof v };
  if (v && typeof v === 'object') return { $type: v instanceof Promise ? 'promise' : 'object' };
  return v;
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input);
const mod = await import(new URL('../src/budget.mjs', import.meta.url));
const results = [];
for (const c of cases) {
  try {
    const f = mod[c.fn];
    if (c.op === 'describe') results.push({ type: typeof f, arity: typeof f === 'function' ? f.length : null });
    else results.push({ value: encode(f(...c.args.map(decode))) });
  } catch (e) {
    results.push({ threw: e && typeof e.name === 'string' ? e.name.slice(0, 40) : 'Error' });
  }
}
write(MARK + JSON.stringify(results) + '\n');
