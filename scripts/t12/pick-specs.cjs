#!/usr/bin/env node
// Picks the spec(s) one G2.5 run may claim, and for a study arm appends a committed context packet to the
// task prompt. Nothing else in the spec changes: paths, verify target and controls stay byte-identical, so
// both arms are checked against one evaluation contract.
//
//   node scripts/t12/pick-specs.cjs <specs.jsonl> <out.jsonl> [spec id] [context variant]
//
// Variant `none` (the default) writes the specs unchanged. Any other variant must be a committed folder
// ops/t12/ab/<variant>/ holding <spec id>.md; a missing packet stops the run rather than run arm A unlabelled.
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const VARIANT = /^ctx-v\d+$/;

function pick(specsText, specId, variant, packetDir) {
  const all = specsText.split('\n').filter((l) => l.trim());
  const keep = specId ? all.filter((l) => JSON.parse(l).id === specId) : all;
  if (keep.length === 0) throw new Error(`no spec with id ${specId}`);
  if (!variant || variant === 'none') return { lines: keep, packets: [] };
  if (!VARIANT.test(variant)) throw new Error(`context variant must be none or ctx-vN, got ${variant}`);
  const packets = [];
  const lines = keep.map((l) => {
    const spec = JSON.parse(l);
    const file = join(packetDir, variant, `${spec.id}.md`);
    if (!existsSync(file)) throw new Error(`no ${variant} packet for ${spec.id}`);
    const packet = readFileSync(file, 'utf8');
    packets.push({ id: spec.id, variant, sha256: createHash('sha256').update(packet).digest('hex') });
    return JSON.stringify({ ...spec, prompt: `${spec.prompt}\n\n${packet}` });
  });
  return { lines, packets };
}

module.exports = { pick };

if (require.main === module) {
  const [specsPath, outPath, specId = '', variant = 'none'] = process.argv.slice(2);
  if (!specsPath || !outPath) {
    console.error('usage: pick-specs.cjs <specs.jsonl> <out.jsonl> [spec id] [context variant]');
    process.exit(2);
  }
  try {
    const { lines, packets } = pick(readFileSync(specsPath, 'utf8'), specId.trim(), variant.trim(), join('ops', 't12', 'ab'));
    writeFileSync(outPath, `${lines.join('\n')}\n`);
    console.log(JSON.stringify({ file: specsPath, specs: lines.map((l) => JSON.parse(l).id), context_variant: variant || 'none', packets }));
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
