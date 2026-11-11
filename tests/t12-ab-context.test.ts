/**
 * Study T12-CTX-AB-2026-11-10-v1: arm B may differ from arm A only in the task prompt, and the packet that
 * makes the difference must never carry a control (the hidden mutation the checker applies).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pick } = require('../scripts/t12/pick-specs.cjs') as { pick: (s: string, id: string, v: string, dir: string) => { lines: string[]; packets: { id: string; sha256: string }[] } };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPacket, declarationOf } = require('../scripts/t12/build-context.cjs') as {
  buildPacket: (spec: unknown, source: string, file: string, base: string) => string;
  declarationOf: (source: string, name: string) => string;
};

const ROOT = join(__dirname, '..');
const AB = join(ROOT, 'ops', 't12', 'ab');
const SPECS_TEXT = readFileSync(join(ROOT, 'ops', 't12', 'specs.jsonl'), 'utf8');
type Spec = { id: string; prompt: string; paths: string[]; verify: { controls?: Array<{ file: string; find: string; replace: string }> } };
const SPECS: Spec[] = SPECS_TEXT.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const PACKETS = readdirSync(join(AB, 'ctx-v1')).filter((f) => f.endsWith('.md'));

describe('the ctx-v1 packets', () => {
  it('exist, each for a real spec', () => {
    expect(PACKETS.length).toBeGreaterThan(0);
    for (const f of PACKETS) expect(SPECS.map((s) => s.id)).toContain(f.replace(/\.md$/, ''));
  });

  it('never contain any control text, from any spec', () => {
    const controls = SPECS.flatMap((s) => (s.verify.controls ?? []).flatMap((c) => [c.find, c.replace]));
    expect(controls.length).toBeGreaterThan(0);
    for (const f of PACKETS) {
      const packet = readFileSync(join(AB, 'ctx-v1', f), 'utf8');
      for (const c of controls) expect(packet.includes(c)).toBe(false);
    }
  });
});

describe('an arm changes only the prompt', () => {
  it('arm A is the spec byte for byte, and arm B differs only by the appended packet', () => {
    for (const f of PACKETS) {
      const id = f.replace(/\.md$/, '');
      const a = pick(SPECS_TEXT, id, 'none', AB);
      const b = pick(SPECS_TEXT, id, 'ctx-v1', AB);
      expect(a.lines).toEqual([SPECS_TEXT.split('\n').find((l) => l.includes(`"id":"${id}"`))]);
      const [specA, specB] = [JSON.parse(a.lines[0]!), JSON.parse(b.lines[0]!)];
      const packet = readFileSync(join(AB, 'ctx-v1', f), 'utf8');
      expect(specB.prompt).toBe(`${specA.prompt}\n\n${packet}`);
      expect({ ...specB, prompt: '' }).toEqual({ ...specA, prompt: '' });
      expect(b.packets).toHaveLength(1);
      expect(b.packets[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses a missing packet or an unknown variant instead of running arm A unlabelled', () => {
    expect(() => pick(SPECS_TEXT, 'ts-repid-to-tier', 'ctx-v1', AB)).toThrow('no ctx-v1 packet');
    expect(() => pick(SPECS_TEXT, PACKETS[0]!.replace(/\.md$/, ''), 'ctx-../x', AB)).toThrow('context variant');
    expect(() => pick(SPECS_TEXT, 'no-such-spec', 'none', AB)).toThrow('no spec');
  });
});

describe('the packet builder', () => {
  const SOURCE = [
    'export const LIMIT = 500;',
    'export function tier(score: number,',
    '  cap: number): string {',
    "  if (score >= 500) return 'EARNING';",
    "  return 'PROBATIONARY';",
    '}',
  ].join('\n');
  const spec = (controls: Array<{ file: string; find: string; replace: string }>) => ({
    id: 'fixture', repo: 'o/r', prompt: "Write a test, imported as `import { tier, LIMIT } from '../lib/x';`.",
    paths: ['tests/x.test.ts'], verify: { runner: 'jest', target: 'tests/x.test.ts', controls },
  });

  it('stops a signature at the body and gives a const only its name', () => {
    expect(declarationOf(SOURCE, 'tier')).toBe('export function tier(score: number,\n  cap: number): string');
    expect(declarationOf(SOURCE, 'LIMIT')).toBe('export const LIMIT');
    const packet = buildPacket(spec([{ file: 'lib/x.ts', find: "if (score >= 500) return 'EARNING';", replace: "if (score > 500) return 'EARNING';" }]), SOURCE, 'lib/x.ts', 'a'.repeat(40));
    expect(packet).not.toContain('>= 500');
  });

  it('refuses to write a packet that would carry control text (positive control)', () => {
    expect(() => buildPacket(spec([{ file: 'lib/x.ts', find: 'cap: number', replace: 'cap: string' }]), SOURCE, 'lib/x.ts', 'a'.repeat(40))).toThrow('control text');
  });
});

describe('the G2.5 workflow', () => {
  const g25 = readFileSync(join(ROOT, '.github', 'workflows', 't12-g25-dogfood.yml'), 'utf8');
  it('runs arm A unless a variant is chosen, and can pin the target commit', () => {
    expect(g25).toMatch(/context_variant:[\s\S]*?options: \['none', 'ctx-v1'\][\s\S]*?default: 'none'/);
    expect(g25).toContain('node scripts/t12/pick-specs.cjs "$SPECS_FILE" "$RUNNER_TEMP/specs.jsonl" "$SPEC_ID" "$CONTEXT_VARIANT"');
    expect(g25).toContain('if [ -n "$EXPECT_BASE" ] && [ "$base" != "$EXPECT_BASE" ]');
    expect(g25).toContain("if: vars.T12_G25_ENABLED == 'true'");
  });
});
