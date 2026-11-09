/**
 * Model-written code runs in a verified container or not at all.
 * The first block needs no Docker. The attack block runs where Docker exists and says NOT_CHECKED where it does not.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitAdapters, type PrClient } from '../src/orchestration/t12-lane-git';
import type { Handle, LaneSpec, Submission } from '../src/orchestration/t12-lane-store';
import { CHECK_LIMITS, createArgs, dockerSandbox, PINNED_DIGEST, PINNED_IMAGE, SANDBOX_ENV, TMPFS_OPTS, WORK_MOUNT, WORKER_USER, type Exec, type ExecResult, type SandboxLimits } from '../src/orchestration/t12-sandbox';

const ok = (stdout = ''): ExecResult => ({ status: 0, stdout, stderr: '', error: null, timedOut: false });
const fail = (stderr = 'no'): ExecResult => ({ status: 1, stdout: '', stderr, error: null, timedOut: false });

function goodInspect(source: string, limits: SandboxLimits, over: Record<string, unknown> = {}) {
  return {
    Config: { User: WORKER_USER, Env: ['PATH=/usr/bin', ...SANDBOX_ENV] },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Privileged: false,
      PidsLimit: limits.pids, Memory: limits.memoryBytes, MemorySwap: limits.memoryBytes, NanoCpus: Math.round(limits.cpus * 1e9), Tmpfs: { '/tmp': TMPFS_OPTS }, ...over,
    },
    Mounts: [{ Type: 'bind', Source: source, Destination: WORK_MOUNT, RW: false }],
    State: { ExitCode: 0, OOMKilled: false },
  };
}

function fakeDocker(source: string, over: { version?: ExecResult; digests?: string[]; inspect?: Record<string, unknown>; exitCode?: number; timedOut?: boolean } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'version') return over.version ?? ok('27.0');
    if (args[0] === 'image') return ok(JSON.stringify([{ RepoDigests: over.digests ?? [`node@${PINNED_DIGEST}`], Config: { Env: ['PATH=/usr/bin'] } }]));
    if (args[0] === 'create') return ok('abc123\n');
    if (args[0] === 'container') {
      const body = goodInspect(source, CHECK_LIMITS, over.inspect);
      body.State.ExitCode = over.exitCode ?? 0;
      return ok(JSON.stringify([body]));
    }
    if (args[0] === 'wait') return { ...ok('0'), timedOut: Boolean(over.timedOut), status: over.timedOut ? null : 0 };
    return ok('');
  };
  return { exec, calls };
}

describe('the sandbox refuses rather than runs', () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 't12-sb-'))); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const command = ['node', '--test', 'x.mjs'];

  it('the container profile carries every restriction and passes no host environment', () => {
    const a = createArgs('n', CHECK_LIMITS, '/w', command);
    for (const want of ['--read-only', '--cap-drop', 'ALL', 'no-new-privileges', WORKER_USER, PINNED_IMAGE]) expect(a).toContain(want);
    expect(a[a.indexOf('--network') + 1]).toBe('none');
    expect(a.join(' ')).toContain(`type=bind,src=/w,dst=${WORK_MOUNT},readonly`);
    expect(a).not.toContain('--env-file');
    expect(a.filter((x, i) => a[i - 1] === '--env')).toEqual([...SANDBOX_ENV]);
    expect(a.slice(a.indexOf(PINNED_IMAGE) + 1)).toEqual(command);
  });

  it('refuses a mount path that could inject mount options', () => {
    expect(() => createArgs('n', CHECK_LIMITS, '/w,dst=/etc', command)).toThrow('comma');
  });

  it('no container runtime: refused, and nothing is created', async () => {
    const { exec, calls } = fakeDocker(dir, { version: { ...fail('none'), error: 'ENOENT' } });
    expect(await dockerSandbox(exec)({ dir, command })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('no container runtime') });
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('an image without the pinned digest: refused before create', async () => {
    const { exec, calls } = fakeDocker(dir, { digests: ['node@sha256:other'] });
    expect(await dockerSandbox(exec)({ dir, command })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('pinned digest') });
    expect(calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it.each([
    ['network on', { NetworkMode: 'bridge' }, 'NetworkMode'],
    ['writable root', { ReadonlyRootfs: false }, 'ReadonlyRootfs'],
    ['a capability added', { CapAdd: ['SYS_ADMIN'] }, 'CapAdd'],
    ['privileged', { Privileged: true }, 'Privileged'],
    ['no process limit', { PidsLimit: 0 }, 'PidsLimit'],
  ])('%s as read back from Docker: never started, and removed', async (_name, inspect, field) => {
    const { exec, calls } = fakeDocker(dir, { inspect });
    expect(await dockerSandbox(exec)({ dir, command })).toMatchObject({ kind: 'refused', reason: expect.stringContaining(field) });
    expect(calls.some((c) => c[0] === 'start')).toBe(false);
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('runs a verified container and reports its exit code', async () => {
    const { exec, calls } = fakeDocker(dir, { exitCode: 7 });
    expect(await dockerSandbox(exec)({ dir, command })).toMatchObject({ kind: 'ran', code: 7, ranOut: false });
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });

  it('a timeout is not a pass or a fail', async () => {
    const { exec, calls } = fakeDocker(dir, { timedOut: true });
    expect(await dockerSandbox(exec)({ dir, command })).toMatchObject({ kind: 'ran', code: null, ranOut: true });
    expect(calls.some((c) => c[0] === 'kill')).toBe(true);
  });
});

describe('a check with no sandbox does not run the code', () => {
  it('reports NOT_CHECKED and the code never executes on the host', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 't12-noexec-')));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      const origin = join(root, 'origin.git');
      const canon = join(root, 'canon');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
      execFileSync('git', ['clone', '-q', origin, canon], { stdio: 'ignore' });
      git(canon, 'config', 'user.email', 't@t');
      git(canon, 'config', 'user.name', 't');
      git(canon, 'checkout', '-q', '-b', 'main');
      writeFileSync(join(canon, 'a.txt'), 'a\n');
      git(canon, 'add', '.');
      git(canon, 'commit', '-q', '-m', 'seed');
      git(canon, 'push', '-q', 'origin', 'main');
      const base = git(canon, 'rev-parse', 'HEAD');

      const marker = join(root, 'EXECUTED').replace(/\\/g, '/');
      const spec: LaneSpec = { id: 'noexec', repo: 'DealAppSeo/trustshell', title: 't', prompt: 'p', paths: ['evil.test.mjs'], verify: { runner: 'node-test', target: 'evil.test.mjs' }, risk: 'LOW' };
      git(canon, 'checkout', '-q', '-b', 't12/noexec-e1');
      writeFileSync(join(canon, 'evil.test.mjs'), `import fs from 'node:fs';\nfs.writeFileSync('${marker}', 'ran');\n`);
      git(canon, 'add', '.');
      git(canon, 'commit', '-q', '-m', 'evil');
      const commit = git(canon, 'rev-parse', 'HEAD');
      git(canon, 'checkout', '-q', 'main');

      const noDocker: Exec = async () => ({ status: null, stdout: '', stderr: '', error: 'ENOENT', timedOut: false });
      const pr: PrClient = { findByBranch: () => null, createDraft: () => '' };
      const adapters = createGitAdapters({ repoDirs: { [spec.repo]: canon }, workRoot: join(root, 'w'), ask: async () => ({ outcome: 'answered', host: 'local', tried: ['local'], text: '' }) as never, allowExec: true, pr, sandbox: dockerSandbox(noDocker) });
      const sub: Submission = { branch: 't12/noexec-e1', commit, base, files: ['evil.test.mjs'], host: null };
      const h: Handle = { taskId: 1, actor: 'trinity-lane-2', epoch: 1, spec, attempts: 0, submission: sub };
      expect(await adapters.check(h)).toMatchObject({ outcome: 'not_checked', reason: expect.stringContaining('no container runtime') });
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('no production file can reach a host runner', () => {
    const dir = join(__dirname, '..', 'src', 'orchestration');
    const git = readFileSync(join(dir, 't12-lane-git.ts'), 'utf8');
    expect(git).not.toMatch(/process\.execPath/);
    for (const f of readdirSync(dir).filter((n) => n.startsWith('t12-'))) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/t12-host-sandbox|hostSandboxForTests/);
  });
});

const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
const dockerOn = docker.status === 0 && docker.stdout.trim() !== '' && process.platform === 'linux';
const describeDocker = dockerOn ? describe : describe.skip;
if (!dockerOn) {
  // eslint-disable-next-line no-console
  console.warn('[t12-sandbox] NOT_CHECKED: the attack block needs Docker on Linux. A skip here is not a pass.');
}

const ATTACK = `
import fs from 'node:fs'; import net from 'node:net'; import dns from 'node:dns/promises'; import { spawn, execFileSync } from 'node:child_process';
const [hostFile, netHost, netPort, workDir] = process.argv.slice(2);
const attempt = (f) => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, code: e.code ?? String(e.message).slice(0, 60) }; } };
const out = {};
out.uid = process.getuid();
out.secretEnv = process.env.T12_SYNTH_SECRET ?? null;
out.hostFile = attempt(() => fs.readFileSync(hostFile, 'utf8'));
out.pid1Env = attempt(() => fs.readFileSync('/proc/1/environ', 'utf8').includes('T12_SYNTH_SECRET'));
out.parentEnv = attempt(() => fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8').includes('T12_SYNTH_SECRET'));
out.capEff = /CapEff:\\s*(\\S+)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1];
out.writeWork = attempt(() => fs.writeFileSync(workDir + '/EVIL_WORK', 'x'));
out.writeEtc = attempt(() => fs.writeFileSync('/etc/EVIL_ETC', 'x'));
out.writeRoot = attempt(() => fs.writeFileSync('/EVIL_ROOT', 'x'));
out.writeTmp = attempt(() => fs.writeFileSync('/tmp/ok', 'x'));
out.execTmp = attempt(() => { fs.writeFileSync('/tmp/run.sh', '#!/bin/sh\\necho hi\\n', { mode: 0o755 }); return execFileSync('/tmp/run.sh', { encoding: 'utf8' }); });
out.network = await new Promise((r) => { const s = net.connect({ host: netHost, port: Number(netPort), timeout: 4000 }); s.on('connect', () => { s.destroy(); r({ ok: true }); }); s.on('error', (e) => r({ ok: false, code: e.code })); s.on('timeout', () => { s.destroy(); r({ ok: false, code: 'TIMEOUT' }); }); });
out.dns = await Promise.race([dns.lookup('example.com').then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code })), new Promise((r) => setTimeout(() => r({ ok: false, code: 'TIMEOUT' }), 4000))]);
const kids = []; let spawned = 0; let spawnError = null;
await new Promise((done) => { const next = () => { if (spawned >= 40 || spawnError) return done(); const c = spawn('sleep', ['20']); c.once('error', (e) => { spawnError = e.code ?? 'error'; done(); }); c.once('spawn', () => { kids.push(c); spawned++; setImmediate(next); }); }; next(); });
kids.forEach((k) => k.kill('SIGKILL'));
out.spawned = spawned; out.spawnError = spawnError;
console.log('RESULT' + JSON.stringify(out));
process.exit(0);
`;

describeDocker('hostile code inside the real container', () => {
  const SECRET = 'synthetic-secret-do-not-use-0123456789';
  const limits: SandboxLimits = { pids: 16, memoryBytes: 256 * 1024 * 1024, cpus: 1, timeoutMs: 120_000 };
  let root: string; let work: string; let hostFile: string; let server: Server; let port: number;
  const parse = (o: string) => JSON.parse(o.slice(o.indexOf('RESULT') + 6).split('\n')[0]!);

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 't12-attack-')));
    work = join(root, 'work');
    execFileSync('mkdir', ['-p', work]);
    writeFileSync(join(work, 'attack.mjs'), ATTACK);
    hostFile = join(root, 'host-secret.txt');
    writeFileSync(hostFile, SECRET);
    server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
    port = (server.address() as AddressInfo).port;
    process.env.T12_SYNTH_SECRET = SECRET;
  });
  afterAll(async () => {
    delete process.env.T12_SYNTH_SECRET;
    await new Promise((r) => server.close(r));
    spawnSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
  });

  it('CONTROL: the same script, on the host, finds the secret, the file, the network and can write', () => {
    const o = parse(execFileSync(process.execPath, ['attack.mjs', hostFile, '127.0.0.1', String(port), work], { cwd: work, encoding: 'utf8', env: { ...process.env } }));
    expect(o.secretEnv).toBe(SECRET);
    expect(o.hostFile).toEqual({ ok: true, value: SECRET });
    expect(o.network).toEqual({ ok: true });
    expect(o.writeWork.ok).toBe(true);
    expect(o.spawned).toBe(40);
    expect(existsSync(join(work, 'EVIL_WORK'))).toBe(true);
    rmSync(join(work, 'EVIL_WORK'));
  }, 60_000);

  it('inside the sandbox, every one of those is refused', async () => {
    const gateway = execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim() || '172.17.0.1';
    const r = await dockerSandbox(undefined, limits)({ dir: work, command: ['node', 'attack.mjs', hostFile, gateway, String(port), WORK_MOUNT] });
    if (r.kind !== 'ran') throw new Error(`refused: ${r.reason}`);
    expect(r.code).toBe(0);
    const o = parse(r.output);
    expect(o.uid).toBe(65534);
    expect(o.secretEnv).toBeNull();
    expect(o.hostFile.ok).toBe(false);
    expect(o.pid1Env.ok && o.pid1Env.value).toBe(false);
    expect(o.parentEnv.ok && o.parentEnv.value).toBe(false);
    expect(o.capEff).toBe('0000000000000000');
    expect(o.writeWork.ok).toBe(false);
    expect(o.writeEtc.ok).toBe(false);
    expect(o.writeRoot.ok).toBe(false);
    expect(o.writeTmp.ok).toBe(true);
    expect(o.execTmp.ok).toBe(false);
    expect(o.network.ok).toBe(false);
    expect(o.dns.ok).toBe(false);
    expect(o.spawned).toBeLessThan(limits.pids);
    expect(o.spawnError).not.toBeNull();
    expect(readdirSync(work)).toEqual(['attack.mjs']);
    expect(r.output).not.toContain(SECRET);
  }, 300_000);
});
