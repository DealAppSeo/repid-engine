/**
 * CANONICALIZATION (CC, 2026-06-24 r5) — close string-evasion at the ROOT.
 *
 * The round-4 classifier matched RAW strings, so attackers slipped past with whitespace,
 * ref prefixes, case, comments, and homoglyphs. Everything that gets matched is now folded to
 * a canonical form FIRST: NFKC → homoglyph→ASCII → strip zero-width → lowercase.
 */

/** Common confusable code points (Cyrillic / Greek / fullwidth) → ASCII. Extend as attacks appear. */
const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic lowercase
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y',
  'х': 'x', 'и': 'u', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't',
  'в': 'b', 'г': 'r',
  // Cyrillic uppercase
  'А': 'a', 'Е': 'e', 'О': 'o', 'Р': 'p', 'С': 'c', 'У': 'y',
  'Х': 'x', 'К': 'k', 'М': 'm', 'Н': 'h', 'Т': 't', 'В': 'b',
  'І': 'i', 'Ј': 'j', 'П': 'n',
  // Greek
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i',
  'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't',
  'Χ': 'x', 'ο': 'o', 'α': 'a', 'ε': 'e', 'κ': 'k', 'ρ': 'p',
};

const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

export function foldHomoglyphs(s: string): string {
  let out = '';
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '');
}

/** Normalize whitespace to single ASCII spaces, fold homoglyphs, NFKC, strip zero-width, lowercase. */
export function canonicalizeText(s: string): string {
  return stripZeroWidth(foldHomoglyphs(s.normalize('NFKC')))
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function tryDecodeHex(s: string): string | null {
  const hexRegex = /\b([0-9a-fA-F]{8,})\b/g;
  let match;
  let decodedCombined = '';
  while ((match = hexRegex.exec(s)) !== null) {
    const hex = match[1];
    if (hex.length % 2 !== 0) continue;
    try {
      const decoded = Buffer.from(hex, 'hex').toString('utf8');
      if (/^[\x20-\x7E\s\r\n\t]+$/.test(decoded)) {
        decodedCombined += ' ' + decoded;
      }
    } catch (e) {}
  }
  return decodedCombined.trim() || null;
}

export function tryDecodeBase64(s: string): string | null {
  const parts = s.split('=');
  let decodedCombined = '';
  const b64Regex = /([A-Za-z0-9+/]{4,}(?:\s+[A-Za-z0-9+/]{4,})*)/g;

  for (const part of parts) {
    let match;
    const localRegex = new RegExp(b64Regex);
    while ((match = localRegex.exec(part)) !== null) {
      const rawStr = match[1];
      const cleanB64 = rawStr.replace(/\s+/g, '');
      if (cleanB64.length < 8) continue;
      try {
        const decoded = Buffer.from(cleanB64, 'base64').toString('utf8');
        if (/^[\x20-\x7E\s\r\n\t]+$/.test(decoded)) {
          decodedCombined += ' ' + decoded;
        }
      } catch (e) {}
    }
  }
  return decodedCombined.trim() || null;
}

/** Strip SQL comments (block, line, hash) before canonicalizing — keeps single spaces for \b. Decodes obfuscations. */
export function canonicalizeSql(sql: string): string {
  const decHex = tryDecodeHex(sql) ?? '';
  const decB64 = tryDecodeBase64(sql) ?? '';
  const combined = (sql + ' ' + decHex + ' ' + decB64).trim();
  const noComments = combined
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // /* ... */
    .replace(/--.*$/gm, ' ')           // -- line
    .replace(/#.*$/gm, ' ');           // # line
  return canonicalizeText(noComments);
}

/**
 * A keyword regex that tolerates whitespace/zero-width BETWEEN letters (catches "dr op", "d r o p")
 * but is anchored by word boundaries on the OUTSIDE (so "dropdown"/"drop_reason" do NOT match).
 */
export function spacedKeywordRegex(keyword: string): RegExp {
  const inner = keyword.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp(`\\b${inner}\\b`, 'i');
}

/** Does the (already comment-stripped, canonicalized) SQL contain any DDL keyword? Returns the kw or null. */
export function findDdlKeyword(sql: string, keywords: string[]): string | null {
  const canon = canonicalizeSql(sql);
  for (const kw of keywords) {
    if (spacedKeywordRegex(kw).test(canon)) return kw;
  }
  return null;
}

const DEFAULT_GIT_PREFIXES = ['refs/remotes/origin/', 'refs/heads/', 'refs/remotes/', 'origin/', 'upstream/'];

/**
 * Canonicalize a git ref to its comparable name: trim, fold, lowercase, then strip known
 * remote/heads prefixes (longest-first, repeated). 'origin/main', 'refs/heads/main', ' main '
 * all collapse to 'main'. A real feature branch like 'feat/main-refactor' is unaffected.
 */
export function canonicalizeGitRef(ref: string, stripPrefixes: string[] = DEFAULT_GIT_PREFIXES): string {
  let r = canonicalizeText(ref); // also trims + lowercases
  const prefixes = [...stripPrefixes].sort((a, b) => b.length - a.length);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (r.startsWith(p)) {
        r = r.slice(p.length);
        changed = true;
        break;
      }
    }
  }
  return r.trim();
}
