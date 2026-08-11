/**
 * leaf-bin.mjs — find the Poseidon2 `leaf` binary on the machine actually running the demo.
 *
 * WHY THIS EXISTS. `trust-harness-e2e.mjs` defaulted `LEAF_BIN` to
 * `C:/Users/Cash4/repos/HyperDAG-core/services/babybear-leaf/target/release/leaf.exe`.
 * That path exists on exactly one laptop. Everywhere else the Poseidon2 leg and the
 * progressive fold reported UNKNOWN — not because the primitive was missing, but because
 * the demo was looking for it under a username. A reviewer on macOS or Linux who had
 * built the crate correctly still got a gap, and the gap blamed the wrong thing.
 *
 * THE RULE THIS KEEPS. Resolution failure must still be a NAMED gap, never a silent
 * fallback to a JS reimplementation of Poseidon2. The demo's whole claim is that the
 * digest came from the canonical Rust primitive; substituting a hash would prove the demo
 * can hash, not that the circuit can. So this resolver either returns a real path or
 * returns null AND the list of places it looked, so the message can say what to build.
 *
 * PRECEDENCE, highest first:
 *   1. $LEAF_BIN                — explicit wins, unchanged contract for existing callers
 *   2. $HYPERDAG_CORE/...       — a checkout located by env var
 *   3. sibling checkout          — ../HyperDAG-core next to repid-engine, the usual layout
 *   4. nested checkout           — ./HyperDAG-core inside it
 *   5. bare `leaf` on $PATH      — installed via `cargo install`
 *
 * Pure and injectable (`existsFn`, `platform`, `env`) so the precedence is unit-tested
 * without needing a Rust toolchain or a particular filesystem.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { delimiter } from 'node:path';

/** Relative path from a HyperDAG-core checkout root to the built binary. */
const REL_FROM_CORE = ['services', 'babybear-leaf', 'target', 'release'];

/** The binary's name on this platform. */
export function leafBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'leaf.exe' : 'leaf';
}

/**
 * Every place we are willing to look, in precedence order.
 *
 * @param {{repoRoot: string, env?: NodeJS.ProcessEnv, platform?: string}} opts
 * @returns {string[]} absolute-ish candidate paths (PATH entries included)
 */
export function leafBinCandidates({ repoRoot, env = process.env, platform = process.platform }) {
  const bin = leafBinaryName(platform);
  const fromCore = (root) => path.join(root, ...REL_FROM_CORE, bin);
  const out = [];

  if (env.LEAF_BIN) out.push(env.LEAF_BIN);
  if (env.HYPERDAG_CORE) out.push(fromCore(env.HYPERDAG_CORE));

  // Both casings, because the GitHub repo is `HyperDAG-core` but plenty of tooling clones
  // it lowercased (this session's own attached checkout is `/workspace/hyperdag-core`).
  // Windows and macOS would find either; Linux would not, and Linux is where reviewers
  // and CI actually run. Trying both costs one stat call.
  for (const dir of ['HyperDAG-core', 'hyperdag-core']) {
    out.push(fromCore(path.resolve(repoRoot, '..', dir)));
    out.push(fromCore(path.resolve(repoRoot, dir)));
  }

  // $PATH last: an explicitly built checkout should beat whatever is installed globally.
  for (const dir of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    out.push(path.join(dir, bin));
  }
  return out;
}

/**
 * @param {{repoRoot: string, env?: NodeJS.ProcessEnv, platform?: string, existsFn?: (p: string) => boolean}} opts
 * @returns {{path: string|null, tried: string[], source: string|null}}
 */
export function resolveLeafBin({ repoRoot, env = process.env, platform = process.platform, existsFn = existsSync }) {
  const tried = leafBinCandidates({ repoRoot, env, platform });
  for (const c of tried) {
    if (existsFn(c)) {
      const source =
        env.LEAF_BIN && c === env.LEAF_BIN ? 'LEAF_BIN'
          : env.HYPERDAG_CORE && c.startsWith(env.HYPERDAG_CORE) ? 'HYPERDAG_CORE'
            : 'search';
      return { path: c, tried, source };
    }
  }
  return { path: null, tried, source: null };
}

/** The sentence a human needs when it is not found. Names the build, not the absence. */
export function leafBinHelp(tried, platform = process.platform) {
  const shown = tried.slice(0, 4);
  return [
    'build it:  cd HyperDAG-core/services/babybear-leaf && cargo build --release --bin leaf',
    `or set LEAF_BIN=/path/to/${leafBinaryName(platform)}`,
    `looked in: ${shown.join('  ·  ')}${tried.length > shown.length ? `  · (+${tried.length - shown.length} $PATH entries)` : ''}`,
  ];
}
