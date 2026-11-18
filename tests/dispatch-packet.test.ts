import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPacket, PACKET_FIELDS, type TaskPacket } from '../src/orchestration/dispatch-packet';

const NOW = new Date('2026-11-18T10:00:00Z');
const base = (): TaskPacket => JSON.parse(readFileSync(join(__dirname, 'fixtures/dispatch-packet-example.json'), 'utf8'));

describe('dispatch packet', () => {
  it('accepts the example packet and finds it claimable', () => {
    expect(checkPacket(base(), NOW)).toEqual({ ok: true, claimable: true, problems: [], flags: [], operatorBlocked: [] });
  });

  it.each(PACKET_FIELDS.map((f) => [f]))('refuses a packet missing %s', (f) => {
    const p = base() as Record<string, unknown>;
    delete p[f];
    const r = checkPacket(p, NOW);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(`missing field ${f}`);
  });

  it('refuses an empty required field but accepts an empty gate list', () => {
    expect(checkPacket({ ...base(), why_now: '  ' }, NOW).problems).toContain('field why_now is empty');
    expect(checkPacket({ ...base(), prerequisite_gates: [] }, NOW).ok).toBe(true);
  });

  it('refuses a packet whose reviewer is its author, whatever the case', () => {
    const r = checkPacket({ ...base(), reviewer_requirements: { author: 'CC', reviewers: ['dispatcher', ' cc '] } }, NOW);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('a reviewer is the author: self-review is not review');
  });

  it('refuses a packet with no reviewer', () => {
    expect(checkPacket({ ...base(), reviewer_requirements: { author: 'CC', reviewers: [] } }, NOW).problems).toContain('reviewer_requirements names no reviewer');
  });

  it('flags, and does not refuse, a SUPERSEDED reference', () => {
    const p = base();
    p.authoritative_refs[0]!.status = 'SUPERSEDED';
    const r = checkPacket(p, NOW);
    expect(r.ok).toBe(true);
    expect(r.flags.join()).toContain('SUPERSEDED');
  });

  it('flags, and does not refuse, a stale reference; a fresh one is not flagged', () => {
    const p = base();
    p.authoritative_refs[0]!.last_verified = '2026-10-01';
    const r = checkPacket(p, NOW);
    expect(r.ok).toBe(true);
    expect(r.flags.join()).toContain('re-verify');
    expect(checkPacket(base(), NOW).flags).toEqual([]);
  });

  it('refuses a reference missing its owner or with an unknown status or relationship', () => {
    const p = base();
    const ref = p.authoritative_refs[0]! as unknown as Record<string, unknown>;
    delete ref.owner;
    ref.status = 'CURRENT';
    ref.relationship = 'inspired_by';
    const problems = checkPacket(p, NOW).problems.join('\n');
    expect(problems).toContain('missing owner');
    expect(problems).toContain('status CURRENT');
    expect(problems).toContain('relationship inspired_by');
  });

  it('an operator-owned shut gate makes a valid packet unclaimable and names the action', () => {
    const r = checkPacket({ ...base(), prerequisite_gates: [{ gate: 'lane worker role', owner: 'Sean', status: 'pending_operator', action: 'paste migrations/x.sql into the SQL editor' }] }, NOW);
    expect(r).toMatchObject({ ok: true, claimable: false, operatorBlocked: [{ gate: 'lane worker role', action: 'paste migrations/x.sql into the SQL editor' }] });
  });

  it('a verified gate, or a shut gate an agent owns, does not block', () => {
    expect(checkPacket({ ...base(), prerequisite_gates: [{ gate: 'g', owner: 'Sean', status: 'verified' }] }, NOW).claimable).toBe(true);
    expect(checkPacket({ ...base(), prerequisite_gates: [{ gate: 'g', owner: 'CC', status: 'blocked', action: 'run npm install' }] }, NOW).claimable).toBe(true);
  });

  it('refuses a shut gate that names no action', () => {
    expect(checkPacket({ ...base(), prerequisite_gates: [{ gate: 'g', owner: 'Sean', status: 'blocked' }] }, NOW).problems).toContain('gate g is shut and names no action that opens it');
  });

  it('flags an unknown field rather than refusing it', () => {
    const r = checkPacket({ ...base(), extra: 1 }, NOW);
    expect(r.ok).toBe(true);
    expect(r.flags).toContain('unknown field extra: not part of the packet format, ignored');
  });
});
