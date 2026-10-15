/**
 * Preloaded with `node --require` by tests/hal-eval-isolation.test.ts. It records and BLOCKS every
 * outbound TCP connection the process tries: fetch (undici), Redis (ioredis), Postgres (pg) and
 * TLS all end in net.Socket#connect. Each attempt is appended to NET_PROBE_OUT as `CONNECT host:port`
 * and the socket is destroyed before any byte leaves.
 *
 * Every process that loads the probe appends `LOADED <pid>` first, child processes included
 * (NODE_OPTIONS carries the --require). That line is what lets the test tell "no connection" apart
 * from "the probe never ran" (LESSONS §5).
 */
'use strict';
const fs = require('fs');
const net = require('net');

const out = process.env.NET_PROBE_OUT;
if (out) {
  fs.appendFileSync(out, `LOADED ${process.pid}\n`);
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function probeConnect(...args) {
    const opts = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    const target = opts.path ? `ipc:${opts.path}` : `${opts.host || 'localhost'}:${opts.port}`;
    // Local IPC between a parent and its own child is not network egress.
    if (!opts.path) fs.appendFileSync(out, `CONNECT ${target}\n`);
    if (opts.path) return original.apply(this, args);
    process.nextTick(() => this.destroy(new Error(`net-probe: blocked ${target}`)));
    return this;
  };
}
