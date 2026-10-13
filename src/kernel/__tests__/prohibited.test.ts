/**
 * Mission 1 — acceptance test #5: a poisoned repo's attempt to export a secret or write trusted
 * memory is REFUSED, and the receipt records the refusal.
 *
 * The prohibition is a HARD FLOOR under the owner policy: it is screened in decide() before any
 * policy/limit/HAL evidence, so a fully-permissive, VERIFIED, unexpired signed policy cannot allow
 * it — "stake is bounded exposure, never a bypass of a prohibited action". The gate tests below pin
 * exactly that: the ONLY difference between the ALLOW baseline and the refusal is the tool's name.
 *
 * FLAGGED FOR XC1: the MVP has no tool registry and tool.class is caller-asserted, so this screens
 * the DECLARED name. Hardening the pattern set / threat model against a tool that misrepresents its
 * capability behind an innocent name is XC1's review; this is the first version to attack.
 */
import { runUnderKernel } from '../gate';
import { hashArgs, validateReceipt } from '../receipt';
import type { KernelReceipt } from '../types';
import { AGENT_ID, harness, iso, signedPolicy } from './fixtures';
import { classifyProhibited, screenProhibited } from '../prohibited';

const codes = (r: { reasons: Array<{ code: string }> }) => r.reasons.map((x) => x.code);
const check = (r: KernelReceipt, name: string) => r.decision.checks.find((c) => c.name === name)?.outcome;

function toolRequest(name: string, cls: 'read' | 'other' | 'post' = 'read', over: Record<string, unknown> = {}) {
  return {
    agent: { agent_id: AGENT_ID, agent_name: 'kernel-demo-agent' },
    tool: { name, class: cls },
    origin: 'Cli',
    args_hash: hashArgs({ path: 'README.md' }),
    amount_raw: null,
    payee: null,
    asset: null,
    chain_id: null,
    ...over,
  };
}

describe('(1) classification — declared prohibited capabilities, nothing else', () => {
  it.each([
    'secrets.export', 'secret.export', 'export_secret', 'exfiltrate_api_key', 'reveal_private_key',
    'env.dump', 'dotenv.send', 'keyring.upload', 'vault.read', 'credentials.reveal', 'leak_token',
  ])('%s → secret_export', (name) => {
    expect(classifyProhibited(name)).toBe('secret_export');
  });

  it.each([
    'trusted_memory.write', 'memory.write_trusted', 'trusted-memory.upsert', 'canonical_memory.set',
    'memory.append_trusted', 'root_memory.store', 'memory.commit_canonical',
  ])('%s → trusted_memory_write', (name) => {
    expect(classifyProhibited(name)).toBe('trusted_memory_write');
  });

  it.each([
    'repo.read_file', 'x402.pay', 'social.post', 'memory.read', 'memory.read_trusted',
    'secrets.rotate', 'build.run', 'search.web', '', 'export_report',
  ])('%s is NOT prohibited', (name) => {
    expect(classifyProhibited(name)).toBeNull();
  });

  it('screenProhibited yields a prohibited_action reason, and is safe on a missing request', () => {
    const s = screenProhibited(toolRequest('secrets.export'));
    expect(s.prohibited).toBe(true);
    expect(s.capability).toBe('secret_export');
    expect(s.reason?.code).toBe('prohibited_action');
    expect(screenProhibited(null).prohibited).toBe(false);
    expect(screenProhibited(undefined).prohibited).toBe(false);
  });
});

describe('(2) the gate refuses a prohibited capability even under a fully-permissive policy', () => {
  // The baseline proves the setup would otherwise ALLOW: same owner, same signed policy (which lists
  // the `tool` action), same everything — only the tool NAME changes between ALLOW and the refusal.
  it('baseline (positive control): a benign read under this policy is ALLOWED and the tool runs', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn(async () => 'file contents');
    const out = await runUnderKernel(toolRequest('repo.read_file', 'read'), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('a secret export is DENY(prohibited_action), the tool runs 0 times, and the receipt records it', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso); // permits spend/post/tool
    const tool = jest.fn(async () => 'this must never run');
    const out = await runUnderKernel(toolRequest('secrets.export', 'read'), tool, h.deps);

    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('prohibited_action');
    expect(tool).toHaveBeenCalledTimes(0); // refused BEFORE the tool ran
    expect(out.executed).toBe(false);

    const r = out.decision_receipt!;
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(r.decision.verdict).toBe('DENY');
    expect(r.decision.executed).toBe(false);
    expect(check(r, 'not_prohibited')).toBe('FAIL'); // the refusal is in the receipt
    expect(r.decision.reasons.some((x) => x.code === 'prohibited_action')).toBe(true);
    // the recorded detail carries no secret value
    expect(JSON.stringify(r)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]/);
  });

  it('a trusted-memory write is refused the same way, regardless of tool class', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const tool = jest.fn();
    const out = await runUnderKernel(toolRequest('memory.write_trusted', 'other'), tool, h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('prohibited_action');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(check(out.decision_receipt!, 'not_prohibited')).toBe('FAIL');
  });

  it('the floor holds EVEN IF the owner policy explicitly lists the tool action', async () => {
    const h = harness();
    // A policy that says "tool actions are allowed" still cannot allow a prohibited capability.
    await h.ledger.appendPolicy(await signedPolicy(h.owner, { actions: ['spend', 'post', 'tool'] }), iso);
    const out = await runUnderKernel(toolRequest('credentials.reveal', 'read'), jest.fn(), h.deps);
    expect(out.verdict).toBe('DENY');
    expect(codes(out)).toContain('prohibited_action');
  });
});

describe('(3) an ordinary decision is byte-unchanged — the screen records nothing when it does not fire', () => {
  it('a benign read receipt carries no not_prohibited check', async () => {
    const h = harness();
    await h.ledger.appendPolicy(await signedPolicy(h.owner), iso);
    const out = await runUnderKernel(toolRequest('repo.read_file', 'read'), jest.fn(async () => 'ok'), h.deps);
    expect(check(out.decision_receipt!, 'not_prohibited')).toBeUndefined();
    expect(check(out.final_receipt!, 'not_prohibited')).toBeUndefined();
  });
});
