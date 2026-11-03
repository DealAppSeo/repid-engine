#!/usr/bin/env node
/**
 * The untrusted MAKER (Agent Immune System slice, increment 2). A deterministic stub payload that
 * Job A runs INSIDE the TrustShell sandbox. It is the UNTRUSTED half of the trust boundary: the
 * trusted settler (Job B) reads what this writes as DATA only (JSON + hash checks) and NEVER executes,
 * evals, sources or imports it.
 *
 * Rule (deliberately naive): affirm any claim that mentions addition ('+') as TRUE, without computing.
 * Across the two fixture claims this lands exactly one correct (the true sum 2+2=4) and one incorrect
 * (the false sum 2+2=5) — the point of the slice: a plausible agent that is sometimes wrong, caught by
 * the oracle and settled as a legitimate failure.
 *
 * STUB — prod wiring (a real model Maker behind API keys) is the next Sean-gated gate. No secrets here.
 * Dependency-free: node builtins only. Reads <input>/claim.json, writes <outbox>/verdict.json using the
 * TrustShell mission mounts (src/sandbox/mission.ts MOUNTS: /mission/input read-only, /mission/outbox
 * writable). Override the paths with MISSION_INPUT / MISSION_OUTBOX for a Docker-free run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.env.MISSION_INPUT || '/mission/input';
const outbox = process.env.MISSION_OUTBOX || '/mission/outbox';

const claim = JSON.parse(readFileSync(join(inputDir, 'claim.json'), 'utf8'));
const verdict = String(claim.claim ?? '').includes('+') ? 'TRUE' : 'FALSE';
writeFileSync(join(outbox, 'verdict.json'), JSON.stringify({ id: claim.id, verdict }) + '\n');
