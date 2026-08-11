/**
 * INTEGRATION FENCE — no hostile engine may move the cursor on a user's terminal.
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST. The sanitiser was already unit-tested and both
 * binaries were already "audited" by grepping for `${json.` / `${result.` interpolations.
 * That grep MISSED the anchor leg, because its value sat in a plain local (`w`) rather than
 * a property access — so a hostile mock still repainted the screen through step 5 after the
 * fix was believed complete. Auditing call sites by pattern finds the sites you thought of.
 *
 * This runs the ACTUAL programs against an ACTUAL hostile server and inspects the ACTUAL
 * bytes. A new print site that forgets `safe()` fails here whether or not anyone remembered
 * to grep for it, and it will keep working when the code is refactored into shapes no regex
 * anticipated.
 *
 * WHAT COUNTS AS AN ATTACK. Colour (SGR, `ESC [ … m`) is fine — both tools emit it
 * deliberately. What must never appear is anything that MOVES or ERASES: cursor
 * positioning, line clearing, and OSC (window title / clipboard). Those are what let a
 * server erase a red FAIL it did not like and repaint it green.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PKG = path.resolve(__dirname, '../packages/trust-demo');
const CLI = path.join(PKG, 'bin/trust-demo.mjs');
const HARNESS = path.resolve(__dirname, '../scripts/demo/trust-harness-e2e.mjs');
const FIX = path.join(PKG, 'fixtures');

/** Cursor movement / erase — ESC [ ... with a final byte that is NOT 'm'. */
const CURSOR_CSI = /\[[0-?]*[ -/]*[@-ln-~]/;
/** Operating System Command — window title, clipboard. */
const OSC = /\][^]*(?:|\\)/;
/** A carriage return lets the server rewrite the line it is on. */
const CR = /\r/;

/** The payload: clear line, cursor up, clear again, fake a green OK, retitle the window. */
const EVIL =
  '[2K\r[1A[2K\r[32m     OK    everything verified[0m]0;pwned';

let server: Server;
let port: number;

beforeAll(async () => {
  const meta = JSON.parse(readFileSync(path.join(FIX, 'leaf-rangecheck.synthetic.json'), 'utf8'));
  const proofB64 = readFileSync(path.join(FIX, 'leaf-rangecheck.synthetic.plonky3.bin')).toString('base64');
  const s = (v: unknown) => `${v}${EVIL}`;

  server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    const body: Record<string, unknown> =
      url.endsWith('/proof')
        ? {
          agent_id: meta.statement.agent_id,
          scheme: s('plonky3_range_check'),
          proof_bytes: proofB64,
          statement: { ...meta.statement, tier: s(meta.statement.tier) },
          eas: { attestation_uid: s('0xabc'), network: s('base-sepolia'), anchored: true },
          cryptographically_verifiable: true,
        }
        : url.includes('/hal/evaluate')
          ? { verdict: s('VETO'), halScore: 0.91, mode: s('quorum'), evidence: [s('provider-a: contradicts')] }
          : url.includes('/observability/onchain-stats')
            ? { total_writes: s(72) }
            : url.includes('/receipt/')
              ? { contract_id: s('18dd4e05'), price_usdc: s('$1.50'), settlement_url: s('https://x/y'), paid_before_delivery: false }
              : { repid_score: meta.statement.repid_score, tier: s(meta.statement.tier) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const execFileAsync = promisify(execFile);

/**
 * Run a program to completion and return everything it wrote, exit code ignored.
 *
 * ASYNC ON PURPOSE. The first version used execFileSync, which BLOCKS this process's event
 * loop — so the in-process hostile server could never answer, every request failed, and the
 * assertions passed against output containing no server data at all. Three green tests
 * proving nothing. Awaiting the child keeps the loop free to serve.
 */
async function run(file: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [file, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return `${stdout}${stderr}`;
  } catch (e: any) {
    // Both tools legitimately exit non-zero in some configurations (the harness exits 2
    // without dist/). The OUTPUT is the artefact under test, not the status.
    return `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
  }
}

/**
 * Guard against the test passing for the wrong reason. If the child process never reached
 * the server, there is no server-derived text to sanitise and the assertion below is
 * trivially satisfied — a green test proving nothing. The first run of this file did
 * exactly that: three connection failures, three passes. So every case must first show
 * evidence that hostile data actually arrived and was cleaned.
 */
const SERVER_ONLY_MARKER = 'everything verified';

function assertActuallyTalkedToTheEngine(out: string, label: string) {
  // Key on text ONLY the hostile server emits. The first version of this guard matched
  // /RepID|plonky3_range_check/ — which appear in the tools' OWN step titles — so the guard
  // meant to prevent a vacuous pass was itself vacuous. This marker is the payload's inert
  // remains: seeing it proves the response arrived AND that it was neutered into plain text.
  expect(`${label}: hostile payload arrived`).toBe(
    out.includes(SERVER_ONLY_MARKER)
      ? `${label}: hostile payload arrived`
      : `${label}: NEVER REACHED THE ENGINE — output was ${JSON.stringify(out.slice(0, 400))}`,
  );
}

function assertNoCursorControl(out: string, label: string) {
  expect(out.length).toBeGreaterThan(0);
  // Show the offending sequence rather than just "expected false to be true".
  const offenders = [
    ['cursor/erase CSI', CURSOR_CSI],
    ['OSC', OSC],
    ['carriage return', CR],
  ] as const;
  for (const [name, re] of offenders) {
    const m = out.match(re);
    expect(`${label}: ${name} -> ${m ? JSON.stringify(m[0]) : 'none'}`).toBe(`${label}: ${name} -> none`);
  }
}

describe('a hostile engine cannot repaint the terminal', () => {
  test('trust-demo CLI strips every cursor-control sequence', async () => {
    const out = await run(CLI, ['--engine', `http://127.0.0.1:${port}`, '--hal', '--timeout', '5000']);
    assertActuallyTalkedToTheEngine(out, 'trust-demo');
    assertNoCursorControl(out, 'trust-demo');
  });

  test('trust-demo reports the attempt instead of quietly cleaning up', async () => {
    const out = await run(CLI, ['--engine', `http://127.0.0.1:${port}`, '--json', '--timeout', '5000']);
    const parsed = JSON.parse(out.slice(out.indexOf('{')));
    expect(parsed.tampering_detected.length).toBeGreaterThan(0);
  });

  test('trust-harness-e2e strips every cursor-control sequence', async () => {
    // The harness emits its own SGR colour unconditionally; only movement/erase is a bug.
    const out = await run(HARNESS, [], { TRUSTSHELL_API_URL: `http://127.0.0.1:${port}` });
    assertActuallyTalkedToTheEngine(out, 'trust-harness-e2e');
    assertNoCursorControl(out, 'trust-harness-e2e');
  });
});

describe('the fence can actually fail', () => {
  // A checker that has never gone red is not known to be a checker (LESSONS #6).
  test('the same assertion rejects raw, unsanitised output', () => {
    expect(() => assertNoCursorControl(`writes: 72${EVIL}`, 'control')).toThrow();
  });

  test('and accepts ordinary coloured output', () => {
    expect(() => assertNoCursorControl('[32mOK[0m verified\n', 'control')).not.toThrow();
  });
});
