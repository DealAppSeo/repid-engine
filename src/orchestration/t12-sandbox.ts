/**
 * t12-sandbox.ts — where a T12 check runs model-written code: one throwaway container, or not at all.
 *
 * The profile is ported from trustshell `src/sandbox/mission.ts`, which that package does not export:
 * no network, read-only root, every capability dropped, a non-root user, limits, an image pinned by
 * digest. The container is CREATED, `docker inspect` is read back and checked field by field, and only
 * then STARTED. The checkout is bound read-only, so one run cannot rig the next.
 *
 * FAIL CLOSED. Anything short of a verified container is `refused`, which a check reports as NOT_CHECKED.
 * There is no host fallback here, and no flag that adds one.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';

/** node:22-alpine, the same digest trustshell's mission runner pins. */
export const PINNED_DIGEST = 'sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914';
export const PINNED_IMAGE = `node:22-alpine@${PINNED_DIGEST}`;

export interface SandboxLimits { pids: number; memoryBytes: number; cpus: number; timeoutMs: number }
export const CHECK_LIMITS: SandboxLimits = { pids: 256, memoryBytes: 2 * 1024 * 1024 * 1024, cpus: 2, timeoutMs: 5 * 60 * 1000 };

export const WORK_MOUNT = '/work';
export const TMPFS_OPTS = 'noexec,nosuid,nodev,size=256m';
export const WORKER_USER = '65534:65534';
// ponytail: runc only. gVisor (runsc) is the upgrade if a container escape enters the threat model.
export const SANDBOX_RUNTIME = 'runc';
/** Constants, never copied from the parent. Nothing else from the host environment reaches the container. */
export const SANDBOX_ENV: readonly string[] = ['CI=1', 'NODE_ENV=test', 'HOME=/tmp'];

export interface ExecResult { status: number | null; stdout: string; stderr: string; error: string | null; timedOut: boolean }
export type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

export type SandboxResult =
  | { kind: 'ran'; code: number | null; ranOut: boolean; reason: string | null; output: string }
  | { kind: 'refused'; reason: string };
export type SandboxRunner = (input: { dir: string; command: string[]; timeoutMs?: number }) => Promise<SandboxResult>;

const MAX_OUTPUT_CHARS = 8_000;

/** Asynchronous on purpose: lanes share one event loop, and a blocking wait would stop their heartbeats. */
export const nodeExec: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const timedOut = Boolean(e?.killed);
      const status = !e ? 0 : typeof e.code === 'number' ? e.code : null;
      resolve({ status, stdout: stdout ?? '', stderr: stderr ?? '', error: e && typeof e.code !== 'number' ? String(e.code ?? e.message) : null, timedOut });
    });
  });

export interface ObservedProfile {
  NetworkMode: string | null;
  ReadonlyRootfs: boolean | null;
  CapDrop: string[];
  CapAdd: string[];
  SecurityOpt: string[];
  User: string | null;
  Privileged: boolean | null;
  PidsLimit: number | null;
  Memory: number | null;
  MemorySwap: number | null;
  NanoCpus: number | null;
  Tmpfs: Record<string, string>;
  Mounts: Array<{ Type: string | null; Source: string | null; Destination: string | null; RW: boolean | null }>;
  Env: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function observeProfile(j: any): ObservedProfile {
  const hc = j?.HostConfig ?? {};
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const tmpfs: Record<string, string> = {};
  for (const [k, v] of Object.entries(hc.Tmpfs ?? {})) tmpfs[k] = String(v);
  return {
    NetworkMode: str(hc.NetworkMode),
    ReadonlyRootfs: bool(hc.ReadonlyRootfs),
    CapDrop: arr(hc.CapDrop),
    CapAdd: arr(hc.CapAdd),
    SecurityOpt: arr(hc.SecurityOpt),
    User: str(j?.Config?.User),
    Privileged: bool(hc.Privileged),
    PidsLimit: num(hc.PidsLimit),
    Memory: num(hc.Memory),
    MemorySwap: num(hc.MemorySwap),
    NanoCpus: num(hc.NanoCpus),
    Tmpfs: tmpfs,
    Mounts: (Array.isArray(j?.Mounts) ? j.Mounts : []).map((m: any) => ({ Type: str(m?.Type), Source: str(m?.Source), Destination: str(m?.Destination), RW: bool(m?.RW) })),
    Env: arr(j?.Config?.Env),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The fields that do not match what a check requires. Empty means the container may start. */
export function profileProblems(o: ObservedProfile, expected: { source: string; limits: SandboxLimits; imageEnv: readonly string[] }): string[] {
  const { limits } = expected;
  const allowedEnv = new Set([...expected.imageEnv, ...SANDBOX_ENV]);
  const mount = o.Mounts[0];
  const checks: Array<[string, boolean]> = [
    ['NetworkMode', o.NetworkMode === 'none'],
    ['ReadonlyRootfs', o.ReadonlyRootfs === true],
    ['CapDrop', o.CapDrop.some((x) => /^(CAP_)?ALL$/i.test(x))],
    ['CapAdd', o.CapAdd.length === 0],
    ['SecurityOpt', o.SecurityOpt.some((s) => /^no-new-privileges([:=]true)?$/.test(s))],
    ['User', o.User === WORKER_USER],
    ['Privileged', o.Privileged === false],
    ['PidsLimit', o.PidsLimit === limits.pids],
    ['Memory', o.Memory === limits.memoryBytes],
    ['MemorySwap', o.MemorySwap === limits.memoryBytes],
    ['NanoCpus', o.NanoCpus === Math.round(limits.cpus * 1e9)],
    ['Tmpfs', Object.keys(o.Tmpfs).length === 1 && o.Tmpfs['/tmp'] === TMPFS_OPTS],
    ['Mounts', o.Mounts.length === 1 && mount?.Type === 'bind' && mount.RW === false && mount.Destination === WORK_MOUNT && mount.Source === expected.source],
    ['Env', o.Env.every((v) => allowedEnv.has(v))],
  ];
  return checks.filter(([, ok]) => !ok).map(([field]) => field);
}

/** The `docker create` arguments. Pure, so the profile is unit-tested without Docker. */
export function createArgs(name: string, limits: SandboxLimits, source: string, command: readonly string[]): string[] {
  if (source.includes(',')) throw new Error(`mount source contains a comma: ${source}`);
  return [
    'create', '--name', name,
    '--read-only',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', WORKER_USER,
    '--pids-limit', String(limits.pids),
    '--memory', String(limits.memoryBytes),
    '--memory-swap', String(limits.memoryBytes),
    '--cpus', String(limits.cpus),
    '--tmpfs', `/tmp:${TMPFS_OPTS}`,
    '--mount', `type=bind,src=${source},dst=${WORK_MOUNT},readonly`,
    '--workdir', WORK_MOUNT,
    '--runtime', SANDBOX_RUNTIME,
    ...SANDBOX_ENV.flatMap((e) => ['--env', e]),
    PINNED_IMAGE,
    ...command,
  ];
}

async function inspect(exec: Exec, kind: 'container' | 'image', ref: string): Promise<unknown | null> {
  const r = await exec('docker', [kind, 'inspect', ref], 60_000);
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? (parsed[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** The real runner. `exec` is injected only so the refusals can be tested without Docker. */
export function dockerSandbox(exec: Exec = nodeExec, baseLimits: SandboxLimits = CHECK_LIMITS): SandboxRunner {
  return async ({ dir, command, timeoutMs }) => {
    const limits = timeoutMs === undefined ? baseLimits : { ...baseLimits, timeoutMs };
    const refused = (reason: string) => ({ kind: 'refused' as const, reason });

    const version = await exec('docker', ['version', '--format', '{{.Server.Version}}'], 30_000);
    if (version.error || version.status !== 0 || !version.stdout.trim()) return refused('no container runtime is available');

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let image = (await inspect(exec, 'image', PINNED_IMAGE)) as any;
    if (!image) {
      const pull = await exec('docker', ['pull', PINNED_IMAGE], 300_000);
      if (pull.status !== 0) return refused(`could not pull the pinned image: ${(pull.error ?? pull.stderr).slice(0, 200)}`);
      image = await inspect(exec, 'image', PINNED_IMAGE);
    }
    const digests: string[] = Array.isArray(image?.RepoDigests) ? image.RepoDigests.map(String) : [];
    if (!digests.some((d) => d.endsWith(`@${PINNED_DIGEST}`))) return refused('the image does not carry the pinned digest');
    const imageEnv: string[] = Array.isArray(image?.Config?.Env) ? image.Config.Env.map(String) : [];

    let source: string;
    try {
      source = realpathSync(dir);
      createArgs('probe', limits, source, command);
    } catch (e) {
      return refused(`the work directory cannot be mounted: ${(e as Error).message.slice(0, 200)}`);
    }

    const name = `t12-check-${randomBytes(8).toString('hex')}`;
    const created = await exec('docker', createArgs(name, limits, source, command), 60_000);
    if (created.status !== 0) return refused(`docker create failed: ${(created.error ?? created.stderr).slice(0, 200)}`);
    const id = created.stdout.trim().split('\n').pop() ?? name;
    try {
      // Read back what Docker actually configured, BEFORE anything runs.
      const before = await inspect(exec, 'container', id);
      if (!before) return refused('docker inspect failed; not started');
      const expected = { source, limits, imageEnv };
      const bad = profileProblems(observeProfile(before), expected);
      if (bad.length) return refused(`the observed profile does not match, not started: ${bad.join(', ')}`);

      const started = await exec('docker', ['start', id], 60_000);
      if (started.status !== 0) return refused(`docker start failed: ${(started.error ?? started.stderr).slice(0, 200)}`);
      const waited = await exec('docker', ['wait', id], limits.timeoutMs);
      const timedOut = waited.timedOut || waited.status !== 0;
      if (timedOut) await exec('docker', ['kill', id], 30_000);
      const logs = await exec('docker', ['logs', id], 30_000);
      const output = `${logs.stdout}\n${logs.stderr}`.slice(-MAX_OUTPUT_CHARS);
      const after = (await inspect(exec, 'container', id)) as any;
      if (!after) return refused('docker inspect failed after the run; the result cannot be trusted');
      const drift = profileProblems(observeProfile(after), expected);
      if (drift.length) return refused(`the profile changed during the run: ${drift.join(', ')}`);
      const oom = after?.State?.OOMKilled === true;
      const code = typeof after?.State?.ExitCode === 'number' && !timedOut && !oom ? (after.State.ExitCode as number) : null;
      return { kind: 'ran', code, ranOut: code === null, reason: timedOut ? 'timed out' : oom ? 'ran out of memory' : null, output };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    } finally {
      await exec('docker', ['rm', '-f', id], 60_000);
    }
  };
}
