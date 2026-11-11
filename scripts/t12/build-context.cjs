#!/usr/bin/env node
// Builds the "ctx-v1" context packet for each named lane spec: the only thing that differs between arm A
// and arm B of study T12-CTX-AB-2026-11-10-v1. Deterministic, read-only, no network.
//
//   node scripts/t12/build-context.cjs <specs.jsonl> <target clone> <40-hex base sha> <out dir> <spec id>...
//
// A packet holds interface facts read from git objects at the base sha, plus fixed test conventions and
// lessons. It never holds a control's find or replace text: the build refuses rather than write one.
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const CONTEXT_VERSION = 'ctx-v1';

const NAME = /^[A-Za-z_$][\w$]*$/;

/** The declaration head of one exported name: a function's signature, or a const/class/type name. */
function declarationOf(source, name) {
  if (!NAME.test(name)) throw new Error(`not an identifier: ${name}`);
  const lines = source.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|class|type|interface)\\s+${name}\\b`).test(l));
  if (at < 0) throw new Error(`${name} is not exported`);
  const first = lines[at];
  if (/^export\s+(?:async\s+)?function\b/.test(first)) {
    // Collect lines until the parameter list closes and the body opens. Stops at the body, never inside it.
    let head = '';
    let depth = 0;
    for (let i = at; i < lines.length && i < at + 15; i++) {
      for (const ch of lines[i]) { if (ch === '(') depth++; if (ch === ')') depth--; }
      head += (head ? '\n' : '') + lines[i];
      if (depth === 0 && /\{\s*$/.test(lines[i])) return head.replace(/\s*\{\s*$/, '');
    }
    throw new Error(`could not find where ${name}'s signature ends`);
  }
  // A const's value can hold the very code a control breaks, so only its name and declared type go out.
  const m = first.match(new RegExp(`^export\\s+(const|class|type|interface)\\s+${name}\\s*(:\\s*[^=]+?)?\\s*(=|\\{|extends|$)`));
  return `export ${m?.[1] ?? 'const'} ${name}${m?.[2] ? m[2].trimEnd() : ''}`;
}

/** The names a spec's prompt imports, and the module path it imports them from. */
function importsOf(prompt) {
  const m = prompt.match(/import \{ ([^}]+) \} from '([^']+)'/);
  if (!m) throw new Error('the prompt names no import');
  return { names: m[1].split(',').map((s) => s.trim()).filter(Boolean), from: m[2] };
}

function buildPacket(spec, source, file, base) {
  const { names } = importsOf(spec.prompt);
  const decls = names.map((n) => declarationOf(source, n));
  const packet = [
    `Additional context, read from ${spec.repo} at commit ${base}:`,
    '',
    `The exports you will test, as declared in ${file}:`,
    '```ts',
    ...decls,
    '```',
    '',
    'How tests run in this repository:',
    `- Jest with the ts-jest preset. Test files live under tests/ and end in .test.ts.`,
    `- ts-jest compiles each test with TypeScript strict mode, so a type error in the test fails it.`,
    `- Import only the module under test, with the relative path the task gives. describe, it and expect are Jest globals and need no import.`,
    '',
    'Lessons from earlier attempts at tasks like this one:',
    `- Read the source before writing an expected value. An assertion that does not match what the code returns makes the test fail.`,
    `- Keep every expected value a literal written in the test.`,
    `- Reply with one JSON object whose "files" array holds exactly the one test file the task names.`,
    '',
  ].join('\n');
  for (const c of spec.verify.controls ?? []) {
    for (const s of [c.find, c.replace]) {
      if (s && packet.includes(s)) throw new Error(`${spec.id}: packet would contain control text ${JSON.stringify(s)}`);
    }
  }
  return packet;
}

module.exports = { CONTEXT_VERSION, declarationOf, importsOf, buildPacket };

if (require.main === module) {
  const [specsPath, clone, base, outDir, ...ids] = process.argv.slice(2);
  if (!specsPath || !clone || !/^[0-9a-f]{40}$/.test(base ?? '') || !outDir || ids.length === 0) {
    console.error('usage: build-context.cjs <specs.jsonl> <clone> <40-hex base sha> <out dir> <spec id>...');
    process.exit(2);
  }
  const specs = new Map(readFileSync(specsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { const s = JSON.parse(l); return [s.id, s]; }));
  mkdirSync(outDir, { recursive: true });
  for (const id of ids) {
    const spec = specs.get(id);
    if (!spec) throw new Error(`no spec ${id}`);
    const file = (spec.context ?? [])[0];
    if (!file) throw new Error(`${id} names no context file`);
    const source = execFileSync('git', ['-C', clone, 'show', `${base}:${file}`], { encoding: 'utf8' });
    writeFileSync(join(outDir, `${id}.md`), buildPacket(spec, source, file, base));
    console.log(`wrote ${id}.md`);
  }
}
