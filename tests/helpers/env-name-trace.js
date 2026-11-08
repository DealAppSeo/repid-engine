// Preload for tests: records which environment variable NAMES a process reads. Values are never stored.
const fs = require('fs');
const out = process.env.ENV_NAME_TRACE_OUT;
const seen = new Set();
const real = process.env;
process.env = new Proxy(real, {
  get(t, k) { if (typeof k === 'string') seen.add(k); return t[k]; },
  has(t, k) { if (typeof k === 'string') seen.add(k); return k in t; },
  getOwnPropertyDescriptor(t, k) { if (typeof k === 'string') seen.add(k); return Object.getOwnPropertyDescriptor(t, k); },
});
process.on('exit', () => { if (out) fs.writeFileSync(out, [...seen].sort().join('\n')); });
