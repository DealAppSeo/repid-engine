#!/usr/bin/env node
/**
 * HAL adversarial gate runner — three outcomes, never two.
 *
 *   exit 0  VERIFIED     every tier ran and passed, and the failability canary failed as required
 *   exit 2  NOT_CHECKED  the key-free tier passed, but the live-quorum tier could not run
 *   exit 1  FAILED       anything else: a probe failed, the harness died, or the canary passed
 *
 * "We did not look" and "it passed" are different answers and this script never collapses
 * them. The workflow maps the codes back to the same three words.
 *
 * ORDER OF OPERATIONS, and why the canary comes first:
 *   1. Boot the real route (harness/hal-surface.js), hard-block ON.
 *   2. Run hal-failability-canary.yaml and REQUIRE IT TO FAIL. A gate that cannot fail proves
 *      nothing, so a pass from the real suite is not believed until a suite that must fail did.
 *   3. Run hal-adversarial.yaml — deterministic, no provider key needed.
 *   4. If, and only if, the engine's own buildFactCheckProviders() assembled at least one
 *      provider: reboot with the hard block OFF (so probes reach the evaluator instead of
 *      being refused at 400) and run hal-quorum-adversarial.yaml.
 *      Otherwise: report NOT_CHECKED and name what did not run.
 *
 * Usage:  node security/promptfoo/run-gate.mjs
 * Env:
 *   PROMPTFOO_BIN     path to a promptfoo executable (default: npx promptfoo@<pinned>)
 *   HAL_GATE_TIMEOUT  seconds allowed per promptfoo run (default 300 key-free / 900 quorum)
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const ARTIFACT_DIR = join(HERE, '.results');

// Pinned deliberately. An unpinned `promptfoo@latest` means the gate's own verdict can change
// with no commit in this repo, which is the same class of problem as a floating base image.
const PINNED_PROMPTFOO = '0.122.2';

const VERIFIED = 0;
const FAILED = 1;
const NOT_CHECKED = 2;

/**
 * Exit codes that mean "promptfoo never got to judge anything" rather than "an assertion
 * failed". These are INFRASTRUCTURE failures, and the distinction is load-bearing:
 *
 * The failability canary is required to FAIL. The original check accepted any non-zero exit
 * as proof the assertions were live — so when the promptfoo binary was simply absent, every
 * invocation exited 127 and the runner reported "canary failed as required — assertions are
 * live" while nothing had been asserted at all. A canary that is satisfied by its own tool
 * being missing is exactly the fake-pass this gate exists to prevent, one level up.
 *
 * A canary must fail for the RIGHT reason.
 */
const INFRA_EXIT_CODES = new Set([
  124, // our own timeout kill
  127, // spawn error / command not found
  128, // killed by signal
]);

const log = (...a) => console.log(...a);

/**
 * Is the promptfoo binary actually invocable? Run BEFORE any tier.
 *
 * A missing tool is NOT_CHECKED, never FAILED: "we could not look" and "HAL is broken" are
 * different states, and collapsing them is how a red build gets blamed on the wrong thing.
 */
function promptfooAvailable() {
  const bin = process.env.PROMPTFOO_BIN;
  const cmd = bin ?? 'npx';
  const args = bin ? ['--version'] : ['--yes', `promptfoo@${PINNED_PROMPTFOO}`, '--version'];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: HERE, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Boot harness/hal-surface.js and resolve once it prints its ready line. */
function startHarness({ injectionBlock }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HERE, 'harness', 'hal-surface.js')], {
      cwd: REPO_ROOT,
      env: { ...process.env, HAL_INJECTION_BLOCK: injectionBlock ? 'true' : 'false' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    // ts-node compiles the HAL tree on boot; on a cold CI runner this is tens of seconds.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('harness did not become ready within 240s'));
    }, 240_000);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        // dotenv and the family registry print banners before us — take the line that parses,
        // never simply the first line.
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.ready === true) {
          clearTimeout(timer);
          resolve({ child, url: msg.url, quorumProviders: msg.quorum_providers });
          return;
        }
        if (msg && msg.ready === false) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(new Error(`harness failed to start: ${msg.error} — ${msg.detail ?? ''}`));
          return;
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited before becoming ready (code ${code})`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function stopHarness(h) {
  if (!h || !h.child || h.child.exitCode !== null) return;
  h.child.kill('SIGTERM');
  await new Promise((r) => {
    const t = setTimeout(() => {
      h.child.kill('SIGKILL');
      r();
    }, 5000);
    h.child.on('exit', () => {
      clearTimeout(t);
      r();
    });
  });
}

/** Run one promptfoo config. Resolves with its exit code — the caller decides what that means. */
function runPromptfoo(configFile, { url, injectionBlock, timeoutSec, outFile }) {
  const bin = process.env.PROMPTFOO_BIN;
  const cmd = bin ?? 'npx';
  const args = bin
    ? ['eval', '-c', configFile]
    : ['--yes', `promptfoo@${PINNED_PROMPTFOO}`, 'eval', '-c', configFile];
  args.push('--no-cache', '--no-progress-bar', '--output', outFile);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: HERE, // relative file:// refs in the configs resolve from here
      env: {
        ...process.env,
        HAL_GATE_URL: url,
        HAL_INJECTION_BLOCK: injectionBlock ? 'true' : 'false',
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
      },
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(124);
    }, timeoutSec * 1000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(code === null ? 128 : code);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(127);
    });
  });
}

function summarise(lines, verdict) {
  const block = [`### HAL adversarial gate — ${verdict}`, '', ...lines.map((l) => `- ${l}`)].join('\n');
  log('\n' + '='.repeat(72));
  log(`HAL ADVERSARIAL GATE: ${verdict}`);
  for (const l of lines) log(`  - ${l}`);
  log('='.repeat(72));
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, block + '\n');
    } catch {
      /* a summary write is never allowed to change the verdict */
    }
  }
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const notes = [];
  let harness = null;

  try {
    // ---- preflight: is the tool even here? -------------------------------------------
    // Costs one `--version` and removes an entire class of dishonest verdict. Without it a
    // missing binary makes every tier exit 127, which the canary check below used to read as
    // "assertions are live".
    if (!(await promptfooAvailable())) {
      summarise(
        [
          'promptfoo is not invocable — nothing was evaluated.',
          `Set PROMPTFOO_BIN to an installed binary, or allow npx to fetch promptfoo@${PINNED_PROMPTFOO}.`,
          'Reported as NOT_CHECKED, not FAILED: "we could not look" is not "HAL is broken".',
        ],
        'NOT_CHECKED',
      );
      return NOT_CHECKED;
    }

    // ---- tiers 1 + canary share one harness (hard block ON) --------------------------
    harness = await startHarness({ injectionBlock: true });
    notes.push(`harness up on the real \`POST /api/v1/hal/evaluate\` route; quorum providers assembled: ${harness.quorumProviders}`);

    const canaryTimeout = Number(process.env.HAL_GATE_TIMEOUT ?? 300);
    const canaryCode = await runPromptfoo('hal-failability-canary.yaml', {
      url: harness.url,
      injectionBlock: true,
      timeoutSec: canaryTimeout,
      outFile: join(ARTIFACT_DIR, 'canary.json'),
    });
    if (canaryCode === 0) {
      summarise(
        [
          ...notes,
          'FAILABILITY CANARY PASSED. It is built to fail; a pass means the gate is not actually asserting anything.',
          'Every result from the real suite is therefore untrustworthy and is NOT being reported.',
        ],
        'FAILED',
      );
      return FAILED;
    }
    if (INFRA_EXIT_CODES.has(canaryCode)) {
      // The canary did fail — for the wrong reason. promptfoo crashed, timed out, or was
      // never found, so no assertion was evaluated. Accepting this as "assertions are live"
      // is the fake-pass this whole gate exists to prevent.
      summarise(
        [
          ...notes,
          `FAILABILITY CANARY DID NOT RUN (promptfoo exit ${canaryCode} — timeout, crash, or missing binary).`,
          'It failed, but not by failing an assertion, so it proves nothing about whether the gate can fail.',
          'Reported as NOT_CHECKED rather than a pass or a HAL failure.',
        ],
        'NOT_CHECKED',
      );
      return NOT_CHECKED;
    }
    notes.push(`failability canary failed on an assertion (promptfoo exit ${canaryCode}) — assertions are live`);

    const t1Code = await runPromptfoo('hal-adversarial.yaml', {
      url: harness.url,
      injectionBlock: true,
      timeoutSec: Number(process.env.HAL_GATE_TIMEOUT ?? 300),
      outFile: join(ARTIFACT_DIR, 'hal-adversarial.json'),
    });
    if (t1Code !== 0) {
      summarise([...notes, `key-free adversarial tier FAILED (promptfoo exit ${t1Code})`], 'FAILED');
      return FAILED;
    }
    notes.push('key-free tier PASSED: injection screen, refusal path, and response contract hold under every probe');

    // ---- tier 2 — live cross-LLM quorum ----------------------------------------------
    if (harness.quorumProviders < 1) {
      summarise(
        [
          ...notes,
          'live-quorum tier NOT RUN: buildFactCheckProviders() assembled 0 providers (no provider key in this environment)',
          'NOT CHECKED, and not inferable from the tier that did run: whether an injection attempt disturbs a real cross-LLM quorum, ' +
            'and whether the injection screen is still reported alongside a genuine fact-check verdict',
        ],
        'NOT_CHECKED',
      );
      return NOT_CHECKED;
    }

    await stopHarness(harness);
    // Hard block OFF: with it on, a high-confidence injection is refused at 400 before the
    // evaluator is reached, so the quorum would never see these probes at all.
    harness = await startHarness({ injectionBlock: false });
    const t2Code = await runPromptfoo('hal-quorum-adversarial.yaml', {
      url: harness.url,
      injectionBlock: false,
      timeoutSec: Number(process.env.HAL_GATE_TIMEOUT ?? 900),
      outFile: join(ARTIFACT_DIR, 'hal-quorum-adversarial.json'),
    });
    if (t2Code !== 0) {
      summarise([...notes, `live-quorum tier FAILED (promptfoo exit ${t2Code})`], 'FAILED');
      return FAILED;
    }
    notes.push('live-quorum tier PASSED: every probe was answered by a real quorum (mode=fact-check, not degraded)');
    summarise(notes, 'VERIFIED');
    return VERIFIED;
  } catch (e) {
    summarise([...notes, `gate could not complete: ${e && e.message ? e.message : String(e)}`], 'FAILED');
    return FAILED;
  } finally {
    await stopHarness(harness);
  }
}

main().then(
  (code) => process.exit(code),
  // An unhandled throw is FAILED, never a silent success.
  (e) => {
    console.error('[hal-gate] unexpected error:', e);
    process.exit(FAILED);
  },
);
