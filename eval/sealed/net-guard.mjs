/**
 * net-guard.mjs - the "network: none" preload for XC1 sealed evaluation (`node --import`).
 *
 * Node's permission model (--permission) already denies file writes, child processes and workers
 * to the sandboxed processes, but in Node 22 it does not restrict the network. This preload closes
 * the public network entry points before any candidate code runs: TCP/TLS/UDP sockets, servers,
 * DNS, http/https/http2, fetch and WebSocket. Each blocked call writes one marker line to fd 2
 * through a reference captured here (so later code cannot silence it by patching process.stderr),
 * then throws. The evaluator scans for the marker and reports a `network_attempt` tamper finding.
 *
 * BEST EFFORT, AND SAYING SO. This is in-process patching, not a network namespace. Code that
 * reaches a native binding the permission model leaves open is not stopped by this file. The real
 * control is a sandbox with no network interface (P1B). FORMAT.md lists this under "does not prove".
 */
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export const MARKER = 'XC1-NETGUARD-BLOCKED';
const writeSync = fs.writeSync;

function blocked(kind) {
  try {
    writeSync(2, `${MARKER} ${kind}\n`);
  } catch {
    /* fd 2 closed: the throw below still stops the call */
  }
  const e = new Error(`network is disabled in sealed evaluation (${kind})`);
  e.code = 'XC1_NETWORK_DISABLED';
  throw e;
}

function deny(target, name, kind) {
  if (!target) return;
  try {
    Object.defineProperty(target, name, {
      value: function xc1NetworkDisabled() {
        return blocked(kind);
      },
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch {
    /* already non-configurable: leave it, the socket layer below is still closed */
  }
}

deny(net.Socket.prototype, 'connect', 'net.Socket.connect');
deny(net.Server.prototype, 'listen', 'net.Server.listen');
for (const n of ['connect', 'createConnection', 'createServer']) deny(net, n, `net.${n}`);
for (const n of ['connect', 'createServer']) deny(tls, n, `tls.${n}`);
deny(dgram, 'createSocket', 'dgram.createSocket');
for (const m of [http, https]) for (const n of ['request', 'get', 'createServer']) deny(m, n, `http.${n}`);
for (const n of ['connect', 'createServer', 'createSecureServer']) deny(http2, n, `http2.${n}`);
const DNS = ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'reverse'];
for (const n of DNS) deny(dns, n, `dns.${n}`);
for (const n of DNS) deny(dns.promises, n, `dns.promises.${n}`);
for (const n of ['fetch', 'WebSocket', 'EventSource']) deny(globalThis, n, n);

// ESM named imports (`import { connect } from 'node:net'`) read a snapshot; refresh it.
syncBuiltinESMExports();
