#!/usr/bin/env ts-node
/**
 * Dry run of the T12 loop on committed fixtures. Reads files, prints results, writes nothing and
 * opens no connection: no database client is imported anywhere beneath this script.
 *
 *   npx ts-node --transpile-only scripts/t12/rehearse.ts [--specs ops/t12/specs.jsonl]
 *
 * Exit: 0 all five rehearsals pass · 1 one or more did not.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rehearse, type Board, type RehearsalInput } from '../../src/orchestration/t12-rehearsal';
import type { LaneSpec } from '../../src/orchestration/t12-lane-store';

const root = join(__dirname, '..', '..');
const fixtures = join(root, 'tests', 'fixtures', 't12-conductor');
const json = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const at = process.argv.indexOf('--specs');
const specsPath = at === -1 ? join(root, 'ops', 't12', 'specs.jsonl') : process.argv[at + 1];

const board = json<Board>(join(fixtures, 'board-cycle1.json'));
// The cycle-1 board as it stood when K3 had failed its check and no fix had been sent.
const failedBoard: Board = { ...board, events: board.events.filter((e) => e.at <= '2026-11-24T10:36:00Z') };
const specs = readFileSync(specsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneSpec);

const results = rehearse(json<RehearsalInput>(join(fixtures, 'rehearsal.json')), failedBoard, specs);
for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} ${r.n}. ${r.name}\n     ${JSON.stringify(r.got)}\n`);
process.stdout.write(`DRY RUN: ${results.filter((r) => r.pass).length} of ${results.length} passed; no row was written and no connection was opened.\n`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
