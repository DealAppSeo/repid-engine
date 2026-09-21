/**
 * deliver-inbox — the ai_dispatch -> run-agent bridge.
 *
 * WHAT IS WORTH PINNING HERE is the honesty of the reply, not the plumbing.
 * This system has twice caught a self-reported completion that was fabricated
 * (a commit hash that did not exist; a claimed HTTP 200 against an endpoint that
 * 404'd). The whole point of this bridge is that the reply it writes is built
 * from things checked AFTER the run — exit code, git state, a transcript that
 * actually appeared — and that the agent's own words are carried as a labelled
 * CLAIM. So the tests assert exactly that separation.
 */
const { AGENT_FOR, buildReply } = require('../scripts/dispatch/deliver-lib.js');

const row = { id: 1, to_ai: 'xc', subject: 's', content: 'c', priority: 90 } as const;
const clean = { head: 'a'.repeat(40), status: '' };

describe('agent mapping', () => {
  it('maps both inboxes, and xc2 onto the xc binary (there is no xc2 CLI)', () => {
    expect(AGENT_FOR['xc']).toBe('xc');
    expect(AGENT_FOR['xc2']).toBe('xc');
  });

  it('has no mapping for an unknown recipient, so it cannot silently dispatch one', () => {
    expect(AGENT_FOR['ga']).toBeUndefined();
    expect(AGENT_FOR['nope']).toBeUndefined();
  });
});

describe('the reply is built from checked facts, not the agent self-report', () => {
  const run = { code: 0, stdout: 'I committed abc1234 and it is all done.', stderr: '', spawnError: null };

  it('labels the agent output as a CLAIM, never as the verdict', () => {
    const { text } = buildReply({ row, agentKey: 'xc', run, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(text).toContain("AGENT'S OWN OUTPUT — A CLAIM, NOT A VERDICT");
    expect(text).toContain('VERIFIED HERE (not self-reported)');
  });

  it('reports HEAD unchanged even when the agent claims it committed', () => {
    const { text, ok } = buildReply({ row, agentKey: 'xc', run, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(text).toContain('git HEAD unchanged');
    expect(text).toContain('no transcript file appeared');
    // exit 0 is still "delivered" — the runner checks work HAPPENED, not that it is right
    expect(ok).toBe(true);
  });

  it('reports a real commit when HEAD actually moved', () => {
    const after = { head: 'b'.repeat(40), status: ' M reports/2026-09-20/x.md' };
    const { text } = buildReply({ row, agentKey: 'xc', run, before: clean, after, runner: 'deliver-inbox-1' });
    expect(text).toContain('git HEAD moved');
    expect(text).toContain('transcript file(s) appeared');
  });

  it('a non-zero exit is blocked, and says nothing was invented', () => {
    const bad = { code: 3, stdout: 'all good!', stderr: '', spawnError: null };
    const { ok, text } = buildReply({ row, agentKey: 'xc', run: bad, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(ok).toBe(false);
    expect(text).toContain('dispatcher exit code: 3');
    expect(text).toContain('Nothing was invented to fill the gap');
  });

  it('a launch failure is reported as such, not as an empty success', () => {
    const err = { code: null, stdout: '', stderr: '', spawnError: 'spawn ENOENT' };
    const { ok, text } = buildReply({ row, agentKey: 'xc', run: err, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(ok).toBe(false);
    expect(text).toContain('FAILED to launch the agent: spawn ENOENT');
  });

  it('an xc2 row discloses that the xc binary answered it', () => {
    const r2 = { ...row, to_ai: 'xc2' };
    const { text } = buildReply({ row: r2, agentKey: 'xc', run, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(text).toMatch(/no separate 'xc2' binary/);
    expect(text).toMatch(/do not read this as a distinct model/);
  });

  it('always states what it did NOT check', () => {
    const { text } = buildReply({ row, agentKey: 'xc', run, before: clean, after: clean, runner: 'deliver-inbox-1' });
    expect(text).toContain('NOT CHECKED');
    expect(text).toContain('checks that work HAPPENED, not that it is right');
  });
});
