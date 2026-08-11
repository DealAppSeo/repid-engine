/**
 * safe-output.mjs — never let the server draw on the user's terminal.
 *
 * THE VULNERABILITY THIS CLOSES, and why it matters more here than almost anywhere else.
 * This CLI prints server-supplied strings: tier, scheme, contract id, EAS uid, HAL verdict,
 * per-provider evidence. Terminals interpret ANSI escape sequences in whatever bytes they
 * receive. So a hostile or compromised engine can return
 *
 *     "72\x1b[2K\r\x1b[1A\x1b[2K\r\x1b[32m     OK    everything verified\x1b[0m"
 *
 * — erase this line, move up, erase that one too, repaint it green. Demonstrated against a
 * local hostile mock before this module existed: the sequences went straight through and
 * the fake OK rendered, plus `\x1b]0;pwned\x07` retitled the window.
 *
 * The whole argument of this package is "believe your own machine rather than our server".
 * A server that can rewrite lines the client already printed — turning a red FAIL into a
 * green OK — defeats that completely, and defeats it INVISIBLY, which is worse: the
 * cryptography would still be correct, the user would simply be shown something else.
 *
 * So every server-derived value is laundered through `safe()` before it reaches stdout.
 * Our own literals are still coloured normally — the rule is about PROVENANCE, not content.
 *
 * Also bounds length: a multi-megabyte field is its own denial of service against a
 * scrollback buffer.
 */

// Written as an escape, never as a literal control byte: a literal ESC in source is
// invisible in every editor and diff, and one reformat away from being silently dropped —
// which would disable this module without changing anything a reviewer could see.
const ESC = '\u001b';

/** Operating System Command: ESC ] ... (BEL | ST). Sets window title, writes clipboard. */
const OSC = new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)?`, 'g');
/** Control Sequence Introducer: ESC [ ... final byte. Cursor movement, erase, colour. */
const CSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
/** Any other ESC-introduced sequence (charset selection, single shifts, a stray ESC). */
const ESC_OTHER = new RegExp(`${ESC}.?`, 'g');
/**
 * C0 controls + DEL + the C1 range. Deliberately includes \r and \n: a newline inside a
 * VALUE lets the server forge a whole line of our output — the same attack, fewer steps.
 */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Unicode FORMAT characters (category Cf). Invisible, and two of them are attacks:
 *
 *  - BIDI OVERRIDES (U+202A-202E, U+2066-2069) reverse rendering order — "Trojan Source",
 *    CVE-2021-42574. A verdict returned as "VETO\u202EDEVORPPA" reads as approval; a URL
 *    can be made to display a domain it does not point at.
 *  - ZERO-WIDTH characters (U+200B-200D, U+FEFF, U+2060) are invisible entirely, so
 *    "sepolia.base\u200bscan.org" displays as the real explorer and is not.
 *
 * Neither is a C0/C1 control, so the first version of this module let both through — found
 * by testing the assumption rather than re-reading the regex. No legitimate agent tier,
 * scheme, UUID, verdict or URL needs a format character, so all of Cf goes.
 *
 * NOT handled, and deliberately so: homoglyphs (Cyrillic "а" for Latin "a"). Stripping those
 * means deciding which scripts are allowed, which breaks legitimate non-Latin text. The
 * printed URL is the mitigation there — it is the thing worth reading carefully.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

/** Detects anything we would have had to strip. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u;

export const MAX_FIELD = 200;

/**
 * Render an untrusted value as a single-line, escape-free string.
 *
 * @param {unknown} v      the server-supplied value
 * @param {number} [max]   truncate beyond this many characters
 * @returns {string}
 */
export function safe(v, max = MAX_FIELD) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'string') s = v;
  else {
    try { s = typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { s = String(v); }
  }

  // Order matters: strip recognised sequences first so their bodies go with them, then
  // sweep up anything left. Stripping bare controls first would leave "[2K" as visible junk.
  s = s.replace(OSC, '').replace(CSI, '').replace(ESC_OTHER, '').replace(CONTROLS, ' ').replace(FORMAT_CHARS, '');

  if (s.length > max) s = `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
  return s;
}

/**
 * True when a value carried anything that had to be stripped. Lets the CLI SAY the engine
 * tried something, rather than silently cleaning up after it — a sanitised attack is still
 * an attack, and staying quiet about it would be the same "hide the gap" failure this
 * whole demo exists to avoid.
 *
 * @param {unknown} v
 */
export function wasUnsafe(v) {
  return typeof v === 'string' && UNSAFE.test(v);
}
