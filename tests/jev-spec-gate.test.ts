import { readFileSync } from 'node:fs';
import path from 'node:path';
import { jevSpecGate } from '../src/jev/spec-gate';

const ticket = { id: '902', paths: ['src/jev'] };
const inside = { files: ['src/jev/spec-gate.ts'], insertions: 4, deletions: 0 };

describe('jev spec gate', () => {
  it('accepts a diff inside the ticket and ignores how large the diff is', () => {
    expect(jevSpecGate({ ticket, diffStat: inside })).toEqual({
      ok: true,
      reason: 'in_spec',
    });
    expect(
      jevSpecGate({
        ticket,
        diffStat: { files: ['src/jev/spec-gate.ts'], insertions: 99999, deletions: 99999 },
      }),
    ).toEqual({ ok: true, reason: 'in_spec' });
  });

  it('does not score the words in the ticket', () => {
    const paris = jevSpecGate({
      ticket: { id: 'The capital of France is Paris.', paths: ['src/jev'] },
      diffStat: { files: ['src/jev/spec-gate.ts'] },
    });
    const lyon = jevSpecGate({
      ticket: { id: 'The capital of France is Lyon.', paths: ['src/jev'] },
      diffStat: { files: ['src/hal/fact-check.ts'] },
    });
    expect(paris).toEqual({ ok: true, reason: 'in_spec' });
    expect(lyon).toEqual({ ok: false, reason: 'path_outside_ticket' });
  });

  it('returns not checked when the ticket or the diff is missing', () => {
    expect(jevSpecGate({})).toEqual({ ok: false, reason: 'not_checked' });
    expect(jevSpecGate({ ticket: null, diffStat: inside })).toEqual({
      ok: false,
      reason: 'not_checked',
    });
    expect(jevSpecGate({ ticket, diffStat: null })).toEqual({
      ok: false,
      reason: 'not_checked',
    });
    expect(jevSpecGate({ ticket: { id: '902', paths: [] }, diffStat: inside })).toEqual({
      ok: false,
      reason: 'not_checked',
    });
    expect(jevSpecGate({ ticket, diffStat: { files: [] } })).toEqual({
      ok: false,
      reason: 'not_checked',
    });
  });

  it('stays local', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'jev', 'spec-gate.ts'), 'utf8');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('process.env');
    expect(src).not.toContain('typesafe');
    expect(src).not.toContain('TypeSafe');
    expect(src).not.toContain('api.anthropic.com');
    expect(src).not.toContain('anthropic');
  });
});
