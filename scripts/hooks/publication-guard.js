#!/usr/bin/env node
/**
 * publication-guard.js — refuse to PUBLISH a secret or a production identifier.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP THIS CLOSES, AND HOW IT WAS FOUND
 * ════════════════════════════════════════════════════════════════════════════════
 * Every secret control in this repo scans FILES:
 *   - `gitleaks` scans the commits in a push/PR range;
 *   - `resident-secrets` scans the checked-out tree (PR #320).
 * Nothing has ever scanned what an agent WRITES INTO A PULL REQUEST BODY.
 *
 * On 2026-08-04 that gap fired twice in one day. PR #320 published a detailed account
 * naming `service_role.txt`, the Supabase project ref, and a funded wallet address —
 * written under the belief the repo was private. PR #336 published live table row
 * counts and infrastructure names. **`DealAppSeo/repid-engine` is PUBLIC**
 * (`gh api repos/... --jq .visibility` → `public`), while `CLAUDE.md:9` says
 * "Private, proprietary — not for public distribution" and `INFRA_INVENTORY.md` lists
 * it as Private. Both were wrong, and every agent inherited the false premise.
 *
 * A file-only control cannot see any of that: the text never touches the repo. It goes
 * straight from an agent's context to a public URL.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT BLOCKS, AND WHAT IT HONESTLY CANNOT
 * ════════════════════════════════════════════════════════════════════════════════
 * BLOCKS, always, on any publishing command:
 *   - JWTs (`eyJ….eyJ…`) — the shape of every Supabase key;
 *   - 64-hex private keys;
 *   - vendor key prefixes (`sk-`, `gsk_`, `xai-`, `AIza`, …);
 *   - the production Supabase project ref and the word `service_role` beside it;
 *   - wallet addresses known to hold funds.
 *
 * CANNOT reliably block: "internal metrics" as prose. A row count in a sentence is
 * indistinguishable from any other number, and a regex broad enough to catch it would
 * fire on every honest engineering claim and be switched off within a week — the same
 * fate as a hard-fail secret gate over 27 pre-existing findings.
 *
 * That limit is the reason for the SECOND behaviour: on a PUBLIC repo this prints the
 * visibility LOUDLY before every publish. An agent that knows the audience is the
 * internet writes a different PR body. A control that states the premise is worth more
 * than one that pretends to judge prose.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAIL-CLOSED, UNLIKE THE OTHER GUARDS HERE
 * ════════════════════════════════════════════════════════════════════════════════
 * The write-lease fence and the jest reaper fail OPEN, because their worst case is a
 * collision or a slow suite. This one's worst case is a published production key,
 * which cannot be withdrawn — a reader may already have it. So an unreadable
 * `--body-file`, or an error inside the scan, BLOCKS the publish and says why.
 *
 * Register on Bash in .claude/settings.json.
 */

const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

/** Commands that make text visible outside this machine. */
const PUBLISHING = [
  /\bgh\s+pr\s+(create|edit|comment)\b/,
  /\bgh\s+issue\s+(create|edit|comment)\b/,
  /\bgh\s+release\s+create\b/,
  /\bgh\s+gist\s+create\b/,
  /\bgh\s+api\b[^|]*\-X\s*(POST|PATCH|PUT)/i,
];

/**
 * High-signal only. Every pattern here has a real instance behind it; none is
 * speculative, because a guard that cries wolf gets disabled and then the real one
 * gets through.
 */
const FORBIDDEN = [
  { name: 'JWT (Supabase anon/service_role key shape)', re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/ },
  { name: '64-hex private key', re: /\b0x[0-9a-fA-F]{64}\b/ },
  { name: 'OpenAI-style secret key', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'Groq secret key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: 'xAI key', re: /\bxai-[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  {
    name: 'production Supabase project ref',
    re: /qnnpjhlxljtqyigedwkb/,
    note: 'the Trinity production project id — naming it in public tells a reader exactly which host to attack',
  },
  {
    name: 'funded Base Sepolia wallet address',
    re: /0xf6eE1768868c3266868edcA78bC41C50309cb22A/i,
    note: 'this address holds testnet funds and its key was exposed',
  },
];

/** A `0x…64` that is a tx hash or an EAS UID is not a key — but we cannot tell. */
const HEX64_HINT =
  'If this is a transaction hash or an EAS UID rather than a key, truncate it ' +
  '(first 10 chars) — a public body does not need the full value to be checkable.';

function isPublishing(cmd) {
  return PUBLISHING.some((re) => re.test(cmd));
}

/**
 * Everything this command would publish: the command text itself (heredocs and
 * `--body "…"` both live here) plus any file named by `--body-file`.
 */
/**
 * Resolve a path the shell understands but Node may not, returning null when nothing
 * exists.
 *
 * The Bash tool here is Git Bash (MSYS), so `/tmp/x.md` and `/c/Users/...` are ordinary
 * paths to the shell and meaningless to Node on Windows. The guard blocked its OWN PR
 * over `/tmp/pgbody.md` — correct behaviour (it genuinely could not read the file) and
 * a usability defect at the same time. A guard that misfires on the most ordinary path
 * in the repo gets switched off, and then it protects nothing.
 *
 * Mapping is tried in order and never guesses: if no candidate exists on disk we
 * return null and the caller still fails closed.
 */
function resolveCandidate(raw) {
  const candidates = [raw];
  if (raw.startsWith('/tmp/')) candidates.push(join(tmpdir(), raw.slice(5)));
  // MSYS drive form: /c/Users/... -> C:/Users/...
  const drive = raw.match(/^\/([a-zA-Z])\/(.*)$/);
  if (drive) candidates.push(`${drive[1].toUpperCase()}:/${drive[2]}`);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function gatherText(cmd) {
  const parts = [cmd];
  const notes = [];
  for (const m of cmd.matchAll(/--body-file[=\s]+("[^"]+"|'[^']+'|\S+)/g)) {
    const raw = m[1].replace(/^['"]|['"]$/g, '');
    if (raw === '-') continue; // stdin: already in the heredoc, captured above
    const found = resolveCandidate(raw);
    if (!found) {
      // FAIL CLOSED. We cannot scan what we cannot read, and the cost of guessing
      // wrong is a published key.
      notes.push(`--body-file ${raw} could not be read`);
      continue;
    }
    try {
      parts.push(readFileSync(found, 'utf8'));
    } catch (e) {
      notes.push(`--body-file ${raw} unreadable: ${e.message}`);
    }
  }
  return { text: parts.join('\n'), unreadable: notes };
}

function scan(text) {
  return FORBIDDEN.filter((f) => f.re.test(text));
}

/** Repo visibility, cached in .git so this costs one network call per clone. */
function visibility() {
  try {
    const cached = execFileSync('git', ['config', '--get', 'hyperdag.repoVisibility'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (cached) return cached;
  } catch {
    /* not cached yet */
  }
  try {
    const v = execFileSync('gh', ['repo', 'view', '--json', 'visibility', '--jq', '.visibility'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
      .trim()
      .toLowerCase();
    if (v) {
      try {
        execFileSync('git', ['config', 'hyperdag.repoVisibility', v], { stdio: 'ignore' });
      } catch {
        /* cache is best-effort */
      }
      return v;
    }
  } catch {
    /* offline or gh unavailable */
  }
  return 'unknown';
}

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // no stdin: nothing to judge
  }
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cmd = payload?.tool_input?.command;
  if (typeof cmd !== 'string' || !isPublishing(cmd)) process.exit(0);

  const { text, unreadable } = gatherText(cmd);
  const hits = scan(text);
  const vis = visibility();

  if (unreadable.length > 0) {
    process.stderr.write(
      `BLOCKED by publication guard: cannot scan what this would publish — ` +
        `${unreadable.join('; ')}. This guard fails CLOSED because a published key ` +
        `cannot be withdrawn. Write the body to a readable file and retry.\n`,
    );
    process.exit(2);
  }

  if (hits.length > 0) {
    process.stderr.write(
      `BLOCKED by publication guard: this would publish ${hits.length} forbidden ` +
        `value(s) to a repo whose visibility is ${vis.toUpperCase()}.\n`,
    );
    for (const h of hits) {
      process.stderr.write(`  - ${h.name}${h.note ? ` — ${h.note}` : ''}\n`);
    }
    if (hits.some((h) => h.name.includes('64-hex'))) {
      process.stderr.write(`  ${HEX64_HINT}\n`);
    }
    process.stderr.write(
      `Remove the value. Describe the FINDING without the credential: ` +
        `"a production key was committed" is actionable; the key itself is an incident.\n`,
    );
    process.exit(2);
  }

  if (vis === 'public') {
    // Not a block — a premise correction. PR #320 was written in good faith by an
    // agent that believed the repo was private, because CLAUDE.md said so.
    process.stderr.write(
      `NOTE — this repository is PUBLIC. Anything in this body is world-readable and ` +
        `permanent. Live row counts, table names, service names and infrastructure ` +
        `identifiers are not secrets by shape, so this guard cannot catch them; that ` +
        `judgement is yours. State findings, not inventories.\n`,
    );
  }
  process.exit(0);
}

module.exports = { isPublishing, scan, gatherText, visibility, FORBIDDEN, PUBLISHING };

/**
 * Only run when invoked as a hook. Without this guard, `require`ing the module to test
 * it EXECUTES it — it reads stdin and calls `process.exit`, which kills the test
 * runner. Exactly the mistake the jest reaper made with its export shape one file over:
 * the module CONTRACT is as load-bearing as the logic inside it.
 */
if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Even the catch-all fails closed on a publishing command: see the header.
    process.stderr.write(
      `BLOCKED by publication guard: the guard itself failed (${e && e.message}). ` +
        `Refusing to publish unscanned text.\n`,
    );
    process.exit(2);
  }
}
