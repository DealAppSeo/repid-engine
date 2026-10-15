/**
 * Preloaded with `node --require` by tests/hal-eval-isolation.test.ts. Appends one line per event to
 * NET_PROBE_OUT:
 *
 *   LOADED <pid>             this process loaded the probe (the runner, and each node child that
 *                            inherits NODE_OPTIONS)
 *   CONNECT <host:port>      a TCP connection was attempted. fetch (undici), Redis (ioredis),
 *                            Postgres (pg) and TLS all end in net.Socket#connect. It is BLOCKED:
 *                            the socket is destroyed before any byte leaves.
 *   DNS <host>               a dns.lookup / dns.resolve* call, refused with an error
 *   SPAWN-NODE <pid> <file>  this process started a node child. That child must print its own LOADED.
 *   SPAWN-OTHER <pid> <file> this process started something that is not node, so the probe cannot
 *                            run inside it
 *
 * The test passes only when LOADED == 1 + SPAWN-NODE and there is no SPAWN-OTHER (XC1 on #1389).
 * An unprobed child, whether spawned with a fresh env, with --no-node-options or as a non-node
 * binary, therefore FAILS the run. It cannot hide behind an empty CONNECT list.
 *
 * KNOWN LIMIT. A native addon that opens its own sockets (libpq through pg-native, for one) bypasses
 * net.Socket. The isolation therefore also blanks the PG* variables and every database URL, and this
 * repo depends on no native Postgres client.
 */
'use strict';
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const path = require('path');
const childProcess = require('child_process');

const out = process.env.NET_PROBE_OUT;
if (out) {
  const log = (line) => fs.appendFileSync(out, `${line}\n`);
  log(`LOADED ${process.pid}`);

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function probeConnect(...args) {
    const opts = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    // A parent talking to its own child over a local pipe is not network egress.
    if (opts.path) return originalConnect.apply(this, args);
    const target = `${opts.host || 'localhost'}:${opts.port}`;
    log(`CONNECT ${target}`);
    process.nextTick(() => this.destroy(new Error(`net-probe: blocked ${target}`)));
    return this;
  };

  const refuse = (name) => (host, ...rest) => {
    log(`DNS ${host}`);
    const cb = rest.reverse().find((a) => typeof a === 'function');
    const err = Object.assign(new Error(`net-probe: blocked DNS ${name} ${host}`), { code: 'ENOTFOUND' });
    if (cb) process.nextTick(() => cb(err));
  };
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[name] = refuse(name);
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
    dns.promises[name] = async (host) => {
      log(`DNS ${host}`);
      throw Object.assign(new Error(`net-probe: blocked DNS ${name} ${host}`), { code: 'ENOTFOUND' });
    };
  }

  const isNode = (file) => {
    const base = path.basename(String(file || '')).toLowerCase();
    return file === process.execPath || base === 'node' || base === 'node.exe';
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
    const original = childProcess[name];
    childProcess[name] = function probeSpawn(file, ...rest) {
      // fork always starts node. exec/execSync go through a shell: never assume node.
      const node = name === 'fork' || (name !== 'exec' && name !== 'execSync' && isNode(file));
      log(`${node ? 'SPAWN-NODE' : 'SPAWN-OTHER'} ${process.pid} ${String(file).slice(0, 120)}`);
      return original.call(this, file, ...rest);
    };
  }
}
