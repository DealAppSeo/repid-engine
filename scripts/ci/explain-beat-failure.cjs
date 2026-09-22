#!/usr/bin/env node
/**
 * explain-beat-failure.cjs — print WHY a build-loop beat died, but only when it
 * died before it could produce a transcript.
 *
 * WHY THIS EXISTS. `anthropics/claude-code-action` deliberately suppresses the
 * agent's output ("full output hidden for security") and writes it to
 * ${RUNNER_TEMP}/claude-execution-output.json, which is never uploaded as an
 * artifact. That is the right default for a PUBLIC repo. It also means that when
 * the API refuses the very first call, the ONE line that names the cause is
 * discarded, and the loop's own fallback logger can say only "check the run's own
 * log" about a log that does not contain it.
 *
 * MEASURED 2026-09-21/22: four consecutive scheduled beats (runs 35625411648,
 * 35650570177, 35673881095, 35686830998) ended
 *
 *     { "subtype": "success", "is_error": true, "duration_ms": 239,
 *       "num_turns": 1, "total_cost_usd": 0, "modelUsage": {} }
 *
 * The run immediately before (35599984032, same day, same Claude Code 2.1.278,
 * same resolved model) reached 36 turns and billed $1.14 — so the model string
 * was fine and every repo-side variable was identical. The cause was account-side
 * and NOT RECOVERABLE from the logs, because this file did not exist.
 *
 * THE SIGNATURE IS NOT THE CAUSE. That same shape appeared around 2026-09-10 and
 * was fixed on 2026-09-13 (76014d3) by moving the model to a repo variable. It
 * recurred here with a model measured to work. `num_turns:1 / cost 0 /
 * modelUsage {}` means only "the API refused before billing"; a retired model is
 * one of several things that produces it. Guessing which, from the shape alone,
 * has now cost two outages.
 *
 * ── WHAT ACTUALLY MAKES THIS SAFE TO PRINT, in order of load ──
 *
 *   1. THE num_turns GATE (the real control). At num_turns <= 1 the agent never
 *      took a turn: it read no file, ran no command, queried no database. There
 *      is no transcript to disclose because none was produced. That is also why
 *      every OTHER message in the file is printed under the gate and not just the
 *      result object: at turn <= 1 those cannot be agent output, and they are the
 *      likeliest place the refusal is actually named. Above the gate this script
 *      prints a short withheld notice and nothing from the file.
 *   2. GitHub's own masking (the backstop). Every value registered under
 *      `secrets.*` is replaced with *** in log output by the runner itself.
 *   3. The redactor below (defence in depth, and the WEAKEST of the three).
 *
 * Read that order literally. `redact()` is a shape list, and a shape list fails
 * silently and in the safe-looking direction the moment a vendor ships a
 * credential format it does not know — the house defect this repo names about
 * jest `roots`, PROVIDER_HOSTS and the sibling-repo table. It is here to catch a
 * stray, NOT to license printing something the gate would otherwise withhold. If
 * you ever find yourself widening the gate because "the redactor will handle it",
 * that is the bug.
 *
 * NOT A GATE — IT ALWAYS EXITS 0. It runs with `if: always()`, so it fires on
 * green beats too and must never be able to turn one red; and when the beat HAS
 * failed, a second red X on the same job adds noise and no information. The
 * verdict is the printed line, not the exit code. Outcomes it prints:
 *
 *   DIAGNOSTIC EMITTED  — died at turn <= 1; the result object follows
 *   WITHHELD            — reached turn 2+; a transcript may exist, so nothing printed
 *   NOT CHECKED         — no file, unparseable, or no result object found
 *
 * "NOT CHECKED" is never "it passed". Three outcomes, never two.
 *
 * CommonJS on purpose: tests/explain-beat-failure.test.ts require()s this file,
 * matching scripts/check-named-env-vars.cjs. ts-jest cannot dynamic-import ESM
 * without --experimental-vm-modules.
 *
 * Usage:  node scripts/ci/explain-beat-failure.cjs [path-to-claude-execution-output.json]
 *         (defaults to $RUNNER_TEMP/claude-execution-output.json)
 */

'use strict';

const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

/**
 * The gate. A beat that took at most this many turns produced no transcript.
 * Raising this number is a DISCLOSURE DECISION on a public repo, not a tuning
 * knob — at 2 the agent has already run tool calls whose output lands here.
 */
const GATE_MAX_TURNS = 1;

/** Per-string cap. API error messages are short; anything longer is suspect. */
const MAX_STRING = 2000;

/**
 * How many non-init, non-result messages to print under the gate. At
 * num_turns <= 1 these are NOT agent output — the agent took no turn — so they
 * are the likeliest place the refusal is actually named. Capped anyway so a
 * pathological file cannot flood the log.
 */
const OTHER_MESSAGE_CAP = 20;

/**
 * MEASURED 2026-09-22 06:18Z, dispatched run 35694245161 — the first run to carry
 * this script. It worked: it surfaced a synthetic assistant message carrying
 * `is_api_error_message: true` and a request_id, which no previous log had shown.
 * And it then hid the one field that mattered:
 *
 *     .message.content[0].text : [depth limit]
 *
 * The cap was 3 and the error text sits at `.message.content[0].text`. Worse, the
 * array index burned a level of its own, so a one-element array cost as much depth
 * as a nested object. Both are fixed. Breadth, string length and message count still
 * bound the output, so this does not uncap the log — it stops the diagnostic from
 * truncating exactly the thing it exists to print.
 */
const MAX_DEPTH = 6;

/**
 * Credential shapes, most-specific first. Defence in depth only — see the header
 * for why this is the weakest of the three controls and must not be leaned on.
 */
const SECRET_SHAPES = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'anthropic-key'],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, 'supabase-key'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'github-token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github-pat'],
  [/\bxai-[A-Za-z0-9]{16,}/g, 'xai-key'],
  [/\bgsk_[A-Za-z0-9]{16,}/g, 'groq-key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'aws-akid'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'jwt'],
  [/\b0x[0-9a-fA-F]{64}\b/g, 'hex-64'],
  // Catch-all by shape, LAST: a 40+ char unbroken token is not prose. This is the
  // only rule that can cover a credential format nobody here has seen yet.
  [/\b[A-Za-z0-9_-]{40,}\b/g, 'high-entropy'],
];

/** Replace anything credential-shaped, then cap the length. */
function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [re, label] of SECRET_SHAPES) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  if (out.length > MAX_STRING) {
    out = `${out.slice(0, MAX_STRING)}… [truncated ${out.length - MAX_STRING} chars]`;
  }
  return out;
}

/**
 * The action's output file has been a JSON array, and stdout is JSON-lines.
 * Accept both rather than pinning a shape that is not ours to control — a parser
 * that only knows today's shape reports NOT CHECKED the day it changes, which is
 * honest but useless.
 */
function parseMessages(raw) {
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter((m) => m && typeof m === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    /* fall through to JSON-lines */
  }
  const out = [];
  let depth = 0;
  let buf = '';
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (esc) { esc = false; buf += ch; continue; }
    if (ch === '\\' && inStr) { esc = true; buf += ch; continue; }
    if (ch === '"') inStr = !inStr;
    if (!inStr && ch === '{') depth += 1;
    if (!inStr && ch === '}') depth -= 1;
    buf += ch;
    if (depth === 0 && buf.trim()) {
      try {
        const obj = JSON.parse(buf);
        if (obj && typeof obj === 'object') out.push(obj);
      } catch { /* not a complete object yet */ }
      buf = '';
    }
  }
  return out;
}

function findResult(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].type === 'result') return messages[i];
  }
  return null;
}

function findInitModel(messages) {
  const init = messages.find((m) => m && m.type === 'system' && m.subtype === 'init');
  return init && typeof init.model === 'string' ? init.model : null;
}

/**
 * Flatten an object to `key.path : value` lines, redacting every string and
 * bounding depth, breadth and length. Used ONLY under the gate.
 */
function flatten(value, prefix, depth, out) {
  if (depth > MAX_DEPTH) {
    out.push(`${prefix} : [depth limit]`);
  } else if (value === null || value === undefined) {
    out.push(`${prefix} : ${String(value)}`);
  } else if (typeof value === 'string') {
    out.push(`${prefix} : ${redact(value)}`);
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(`${prefix} : ${value}`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${prefix} : []`);
    } else {
      // Array index does NOT burn a depth level: `content[0].text` is one field,
      // not two. Counting it cost the 2026-09-22 06:18Z run its error text.
      value.slice(0, 5).forEach((v, i) => flatten(v, `${prefix}[${i}]`, depth, out));
      if (value.length > 5) out.push(`${prefix}[…] : ${value.length - 5} more element(s)`);
    }
  } else if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push(`${prefix} : {}`);
    } else {
      for (const k of keys.slice(0, 20)) flatten(value[k], `${prefix}.${redact(k)}`, depth + 1, out);
      if (keys.length > 20) out.push(`${prefix}.… : ${keys.length - 20} more key(s)`);
    }
  }
  return out;
}

const RULE = '─'.repeat(72);

/**
 * The whole decision, as a pure function so a test can exercise every branch
 * without a runner, a network, or a failed beat to wait for. This script only
 * ever executes on a failure path — if it were wrong, nobody would find out
 * until the next outage, which is precisely when it is needed.
 */
function explain(raw) {
  const messages = parseMessages(raw);
  if (messages.length === 0) {
    return {
      verdict: 'NOT CHECKED',
      lines: ['NOT CHECKED — output file was empty or contained no JSON object.'],
    };
  }

  const result = findResult(messages);
  if (!result) {
    return {
      verdict: 'NOT CHECKED',
      lines: [
        `NOT CHECKED — parsed ${messages.length} message(s) but none had type "result".`,
        'The action may have changed its output shape; re-read the file by hand.',
      ],
    };
  }

  const turns = typeof result.num_turns === 'number' ? result.num_turns : null;

  if (turns === null) {
    return {
      verdict: 'NOT CHECKED',
      lines: [
        'NOT CHECKED — the result object carries no numeric num_turns, so the',
        'disclosure gate cannot be evaluated. Nothing printed, deliberately:',
        'an ungateable transcript is withheld, not guessed at.',
      ],
    };
  }

  if (turns > GATE_MAX_TURNS) {
    return {
      verdict: 'WITHHELD',
      lines: [
        `WITHHELD — the beat reached turn ${turns} (gate: <= ${GATE_MAX_TURNS}), so a real`,
        'transcript may exist and is NOT printed to this public log.',
        'This step runs on every beat, green or red, and says nothing about which',
        'this was. If the job did fail, the cause is in the beat\'s own ledger entry',
        'or the PR it opened — not here.',
      ],
    };
  }

  const lines = [
    RULE,
    'BEAT DIED BEFORE TURN 2 — the API refused before any billable call.',
    '',
    `Printed only because num_turns (${turns}) <= ${GATE_MAX_TURNS}: the agent never took a turn,`,
    'so no transcript exists to disclose. Values below are redacted and capped.',
    RULE,
  ];

  const initModel = findInitModel(messages);
  if (initModel) lines.push(`  model (from init)  : ${redact(initModel)}`);

  for (const key of Object.keys(result)) {
    if (key === 'type') continue;
    const value = result[key];
    if (value === null || value === undefined) {
      lines.push(`  ${key.padEnd(18)} : ${String(value)}`);
    } else if (typeof value === 'string') {
      lines.push(`  ${key.padEnd(18)} : ${redact(value)}`);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      lines.push(`  ${key.padEnd(18)} : ${value}`);
    } else if (typeof value === 'object') {
      const keys = Object.keys(value);
      lines.push(`  ${key.padEnd(18)} : {${keys.length ? keys.map(redact).join(', ') : 'empty'}}`);
    }
  }

  const others = messages.filter(
    (m) => m !== result && !(m.type === 'system' && m.subtype === 'init'),
  );
  if (others.length > 0) {
    lines.push('');
    lines.push(
      `  ── ${others.length} other message(s); at turn <= ${GATE_MAX_TURNS} these are not agent output ──`,
    );
    for (const msg of others.slice(0, OTHER_MESSAGE_CAP)) {
      for (const line of flatten(msg, '  ', 0, [])) lines.push(line);
    }
    if (others.length > OTHER_MESSAGE_CAP) {
      lines.push(`  … ${others.length - OTHER_MESSAGE_CAP} further message(s) withheld (cap ${OTHER_MESSAGE_CAP}).`);
    }
  }

  lines.push(RULE);
  lines.push('If no field above names a cause, the next step is the Anthropic console:');
  lines.push('API key status and credit balance. A 1-turn, $0, modelUsage:{} result');
  lines.push('means the request was refused before billing — NOT a turn-budget death.');
  lines.push(RULE);

  return { verdict: 'DIAGNOSTIC EMITTED', lines };
}

function main(argv) {
  const explicit = argv[2];
  const file =
    explicit || join(process.env['RUNNER_TEMP'] || '/tmp', 'claude-execution-output.json');

  if (!existsSync(file)) {
    console.log(`NOT CHECKED — no output file at ${file}.`);
    console.log('The action writes it next to the run; if it is absent the beat step');
    console.log('failed before the SDK started (install, auth config, checkout).');
    return 0;
  }

  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    console.log(`NOT CHECKED — could not read ${file}: ${redact(String(err && err.message))}`);
    return 0;
  }

  const { lines } = explain(raw);
  for (const line of lines) console.log(line);
  return 0;
}

module.exports = {
  explain,
  redact,
  flatten,
  MAX_DEPTH,
  parseMessages,
  findResult,
  findInitModel,
  GATE_MAX_TURNS,
  MAX_STRING,
};

if (require.main === module) {
  // Always 0: a reporter, never a gate. See the header.
  process.exit(main(process.argv));
}
