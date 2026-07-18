/**
 * HAL CRAG — lightweight Corrective-RAG evaluator with LAYERED, non-gameable defenses (WS1.2a).
 *
 * WHY THIS EXISTS (ANTIFRAGILE_PROVENANCE_PROGRAM_v0 §"Non-gameable CRAG", 2026-07-18):
 * retrieval (src/hal/retrieval.ts) can be POISONED — the WS1.1 spike found a live spoofed source
 * (#9: a dev-housing.rice.edu page falsely claiming cryptids were confirmed). A naive "the model read
 * the top web result" grader would be trivially gamed by anyone who can publish a page. So CRAG grades
 * evidence through STACKED defenses where the primary, non-gameable lever is INDEPENDENT-SOURCE
 * CORROBORATION — a web claim only reaches high confidence when ≥2 sources of DIFFERENT
 * ownership/domain corroborate the core proposition. Single-source → "Ambiguous" + a disclosure flag.
 *
 * THE LAYERS (spec §"Non-gameable CRAG"):
 *   (a) domain reputation priors + allow/deny list (small seed list, config-extensible via env);
 *   (b) ≥2 INDEPENDENT-SOURCE CORROBORATION — the primary lever (different registrable domain);
 *   (c) provenance-metadata enforcement — sources missing url/timestamp/hash are dropped;
 *   (d) grade = Correct | Ambiguous | Incorrect, plus the evidence used and human-readable reasons.
 * A strong model (grok-4, or gemini-2.5-flash fallback) produces an EVIDENCE-GROUNDED per-source
 * verdict (does THIS source support / contradict / not-address the claim); the corroboration + prior
 * layers then decide the grade. The model never decides alone — "who grades the grader" is answered by
 * requiring independent corroboration on top of the model's read.
 *
 * RESILIENT (RULE-8): NEVER throws. Model failure → falls back to a deterministic corroboration-only
 * grade over the (already provenance-filtered) evidence, so a graded result is always produced. Keys
 * are read from process.env (../.env.master) and NEVER printed.
 */

import type { EvidenceSnippet } from './retrieval';

export type CragGrade = 'Correct' | 'Ambiguous' | 'Incorrect';

/** Per-source, evidence-grounded stance toward the claim (from the grader model, or heuristic). */
export type SourceStance = 'supports' | 'contradicts' | 'neutral';

export interface GradedSource {
  url: string;
  domain: string; // full hostname
  registrable_domain: string; // eTLD+1 — the OWNERSHIP unit for independence counting
  stance: SourceStance;
  domain_prior: number; // 0..1 reputation prior (allow=high, deny=0, default=mid)
  content_hash: string;
  timestamp: string;
}

export interface CragResult {
  grade: CragGrade;
  /** The model/heuristic verdict on the CLAIM in evidence terms: TRUE | FALSE | UNCERTAIN. */
  verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN';
  confidence: number; // 0..100 — the grader's confidence in `verdict`
  /** ≥2-corroboration lever: count of DISTINCT registrable domains that SUPPORT the claim. */
  corroboration_count: number;
  /** Distinct registrable domains that CONTRADICT the claim (drives Incorrect). */
  contradiction_count: number;
  disclosure_flag: boolean; // true when single-source / uncorroborated → must be disclosed downstream
  graded_sources: GradedSource[]; // provenance-filtered + stance-graded evidence actually used
  dropped_for_provenance: number; // sources dropped by layer (c)
  dropped_for_denylist: number; // sources dropped by the deny-list in layer (a)
  reasons: string[]; // human-readable, glass-box
  grader: 'model' | 'heuristic'; // whether the strong model graded, or the deterministic fallback ran
  grader_model?: string; // which model, when grader === 'model'
}

/** Options — thresholds are env/config-driven with safe defaults. */
export interface CragOpts {
  minCorroboration?: number; // default HAL_CRAG_MIN_CORROBORATION or 2 (the ≥2 rule)
  timeoutMs?: number; // grader model timeout, default HAL_CRAG_TIMEOUT_MS or 12000
  maxTokens?: number; // grader max tokens, default 700
}

// ── Layer (a): domain reputation priors + allow/deny seed lists (config-extensible via env) ──
// Small, defensible seed. NOT a truth oracle — a HIGH prior only raises corroboration weight; it can
// never by itself make a single-source claim "Correct" (layer (b) still requires ≥2 independent
// domains). Extend at runtime with HAL_CRAG_ALLOW_DOMAINS / HAL_CRAG_DENY_DOMAINS (comma-separated
// registrable domains), no redeploy.
const SEED_ALLOW: Record<string, number> = {
  'wikipedia.org': 0.85,
  'britannica.com': 0.85,
  'nature.com': 0.9,
  'science.org': 0.9,
  'nih.gov': 0.9,
  'nasa.gov': 0.9,
  'gov.uk': 0.85,
  'reuters.com': 0.8,
  'apnews.com': 0.8,
  'bbc.com': 0.78,
  'bbc.co.uk': 0.78,
  'archive.org': 0.75,
};
// Known low-trust / spoof-prone patterns get a floor prior (still counted, but weighted low).
const SEED_DENY: string[] = []; // empty seed — deny is opt-in via env, avoids false-blocking

function csvEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Multi-part public suffixes we must NOT split as eTLD+1 (so foo.co.uk → foo.co.uk, not co.uk). */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'gov.au', 'edu.au',
  'co.nz', 'govt.nz', 'co.jp', 'ne.jp', 'or.jp', 'go.jp',
  'com.br', 'com.cn', 'com.hk', 'co.in', 'co.za', 'com.sg',
]);

/**
 * Registrable domain (eTLD+1) — the OWNERSHIP unit for independence counting. Two hostnames sharing a
 * registrable domain are ONE owner and count as ONE corroborating source, so a spoofer can't spin up
 * a.example.com + b.example.com to fake "two independent" sources. Heuristic (no PSL dependency):
 * take the last 2 labels, or last 3 when the last 2 are a known multi-part public suffix.
 */
export function registrableDomain(hostname: string): string {
  const h = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Layer (a) prior: allow-list (seed ∪ env) → high; deny-list (seed ∪ env) → 0; else neutral 0.5. */
export function domainPrior(registrable: string): number {
  const allowEnv = csvEnv('HAL_CRAG_ALLOW_DOMAINS');
  const denyEnv = csvEnv('HAL_CRAG_DENY_DOMAINS');
  if ([...SEED_DENY, ...denyEnv].includes(registrable)) return 0;
  if (allowEnv.includes(registrable)) return 0.85;
  if (SEED_ALLOW[registrable] !== undefined) return SEED_ALLOW[registrable]!;
  return 0.5;
}

/** Layer (c): a source is only usable if it has url + timestamp + content_hash + content. */
function hasCompleteProvenance(s: EvidenceSnippet): boolean {
  const p = s?.provenance;
  return Boolean(p && p.url && p.timestamp && p.content_hash && s.content && s.content.trim());
}

// ── The grader model (a STRONG model — the spec names grok-4 / gemini-2.5-flash) ──
interface GraderCfg {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

/** Resolve the strong grader model from env keys (grok-4 first, then gemini-2.5-flash). null if none. */
function resolveGrader(): GraderCfg | null {
  const grok = process.env.GROK_API_KEY?.trim();
  if (grok) {
    return {
      name: 'grok',
      endpoint: process.env.HAL_CRAG_GROK_ENDPOINT ?? 'https://api.x.ai/v1/chat/completions',
      apiKey: grok,
      model: process.env.HAL_CRAG_GROK_MODEL ?? 'grok-4',
    };
  }
  // Gemini fallback — via OpenRouter when present (funded, avoids the direct API's credit 429s), else direct.
  const or = process.env.OPENROUTER_API_KEY?.trim();
  const gm = process.env.GEMINI_API_KEY?.trim();
  if (or) {
    return {
      name: 'gemini',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: or,
      model: process.env.HAL_CRAG_GEMINI_MODEL ?? 'google/gemini-2.5-flash',
    };
  }
  if (gm) {
    return {
      name: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: gm,
      model: process.env.HAL_CRAG_GEMINI_MODEL ?? 'gemini-2.5-flash',
    };
  }
  return null;
}

const CRAG_SYSTEM =
  'You are a meticulous evidence grader. You are given a claim and numbered web sources. For EACH ' +
  'source decide, using ONLY that source, whether it SUPPORTS, CONTRADICTS, or does NOT ADDRESS the ' +
  "claim's core proposition. Then give an overall verdict grounded in the evidence. Output ONLY compact JSON.";

function cragPrompt(claim: string, sources: EvidenceSnippet[]): string {
  const numbered = sources
    .map((s, i) => `[${i + 1}] (${s.provenance.domain}) ${s.content.replace(/\s+/g, ' ').slice(0, 900)}`)
    .join('\n');
  return (
    `Claim: "${String(claim).replace(/"/g, "'").slice(0, 800)}"\n\n` +
    `Sources:\n${numbered}\n\n` +
    'Reply with ONLY this JSON (no prose, no markdown):\n' +
    '{"sources":[{"i":1,"stance":"supports|contradicts|neutral"}],' +
    '"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0-100}\n' +
    '- stance is that ONE source vs the claim; verdict is the claim overall given ALL sources.\n' +
    '- TRUE: evidence confirms the claim. FALSE: evidence contradicts it. UNCERTAIN: not resolvable.'
  );
}

interface GraderOutput {
  stances: SourceStance[]; // aligned by index with the sources passed in
  verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN';
  confidence: number;
}

/** Call the grader model; returns null on ANY failure (never throws). */
async function callGrader(
  cfg: GraderCfg,
  claim: string,
  sources: EvidenceSnippet[],
  timeoutMs: number,
  maxTokens: number,
): Promise<GraderOutput | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: CRAG_SYSTEM },
          { role: 'user', content: cragPrompt(claim, sources) },
        ],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => null);
    const msg = data?.choices?.[0]?.message ?? {};
    const content: string = msg.content || msg.reasoning_content || msg.reasoning || '';
    if (!content.trim()) return null;
    return parseGrader(content, sources.length);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the grader JSON from possibly-verbose output; null when unparseable. */
export function parseGrader(text: string, nSources: number): GraderOutput | null {
  const candidates = text.match(/\{[\s\S]*\}/g) ?? [];
  // Prefer the widest object that carries a verdict key (reasoning models emit prose then JSON).
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  for (const c of ordered) {
    try {
      const o = JSON.parse(c);
      if (o.verdict === undefined && o.sources === undefined) continue;
      const v = String(o.verdict ?? '').toUpperCase();
      const verdict = v === 'TRUE' || v === 'FALSE' || v === 'UNCERTAIN' ? (v as GraderOutput['verdict']) : 'UNCERTAIN';
      let confidence = Number(o.confidence);
      if (!Number.isFinite(confidence)) confidence = 50;
      confidence = Math.max(0, Math.min(100, confidence));
      const stances: SourceStance[] = new Array(nSources).fill('neutral');
      if (Array.isArray(o.sources)) {
        for (const row of o.sources) {
          const idx = Number(row?.i);
          const st = String(row?.stance ?? '').toLowerCase();
          if (Number.isInteger(idx) && idx >= 1 && idx <= nSources) {
            stances[idx - 1] = st === 'supports' || st === 'contradicts' ? (st as SourceStance) : 'neutral';
          }
        }
      }
      return { stances, verdict, confidence };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function clampInt(v: number | string | undefined, def: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Grade retrieved evidence for a claim. Runs the four layers in order and returns a full glass-box
 * CragResult. NEVER throws.
 *
 * Grade logic (after provenance filtering (c) + deny-list (a)):
 *   - ≥ minCorroboration DISTINCT registrable domains SUPPORT and the grader verdict is not FALSE
 *       → Correct (the ≥2-independent-source lever, layer (b)).
 *   - ≥ minCorroboration DISTINCT domains CONTRADICT (and no support quorum) → Incorrect.
 *   - Exactly 1 supporting domain (single-source), or support == contradiction, or no grounded
 *       verdict → Ambiguous + disclosure_flag=true (single-source may NOT reach high confidence).
 */
export async function gradeEvidence(
  claim: string,
  evidence: EvidenceSnippet[],
  opts: CragOpts = {},
): Promise<CragResult> {
  const minCorroboration = clampInt(opts.minCorroboration ?? process.env.HAL_CRAG_MIN_CORROBORATION, 2, 1, 5);
  const timeoutMs = clampInt(opts.timeoutMs ?? process.env.HAL_CRAG_TIMEOUT_MS, 12000, 1000, 30000);
  const maxTokens = clampInt(opts.maxTokens, 700, 100, 2000);
  const reasons: string[] = [];

  const input = Array.isArray(evidence) ? evidence : [];

  // Layer (c): provenance enforcement — drop sources missing url/timestamp/hash/content.
  const provenanced = input.filter(hasCompleteProvenance);
  const droppedForProvenance = input.length - provenanced.length;
  if (droppedForProvenance > 0) {
    reasons.push(`Layer (c): dropped ${droppedForProvenance} source(s) missing url/timestamp/content_hash.`);
  }

  // Layer (a): deny-list removal (prior 0). Allow/neutral priors are kept but weighted.
  const denyKept: EvidenceSnippet[] = [];
  let droppedForDenylist = 0;
  for (const s of provenanced) {
    const rd = registrableDomain(s.provenance.domain);
    if (domainPrior(rd) === 0) {
      droppedForDenylist += 1;
    } else {
      denyKept.push(s);
    }
  }
  if (droppedForDenylist > 0) {
    reasons.push(`Layer (a): dropped ${droppedForDenylist} source(s) on the deny-list.`);
  }

  const usable = denyKept;
  if (usable.length === 0) {
    reasons.push('No usable evidence after provenance + deny-list filtering → Ambiguous (disclosure).');
    return {
      grade: 'Ambiguous',
      verdict: 'UNCERTAIN',
      confidence: 0,
      corroboration_count: 0,
      contradiction_count: 0,
      disclosure_flag: true,
      graded_sources: [],
      dropped_for_provenance: droppedForProvenance,
      dropped_for_denylist: droppedForDenylist,
      reasons,
      grader: 'heuristic',
    };
  }

  // Grader model (strong) → per-source stances + overall verdict. Fallback to heuristic on failure.
  const cfg = resolveGrader();
  let graderOut: GraderOutput | null = null;
  let graderKind: CragResult['grader'] = 'heuristic';
  let graderModel: string | undefined;
  if (cfg) {
    graderOut = await callGrader(cfg, claim, usable, timeoutMs, maxTokens);
    if (graderOut) {
      graderKind = 'model';
      graderModel = cfg.model;
      reasons.push(`Grader: ${cfg.name}/${cfg.model} verdict ${graderOut.verdict} @${graderOut.confidence}%.`);
    } else {
      reasons.push('Grader model unavailable/errored → deterministic corroboration-only fallback.');
    }
  } else {
    reasons.push('No grader key present → deterministic corroboration-only fallback.');
  }

  // Build the graded-source rows. Without a model verdict, the heuristic treats an allow-listed
  // (prior ≥ 0.75) source as weak 'supports' and everything else 'neutral' — corroboration then still
  // requires ≥2 DISTINCT domains, so the fallback can never over-confidently confirm on a single page.
  const graded: GradedSource[] = usable.map((s, i) => {
    const rd = registrableDomain(s.provenance.domain);
    const prior = domainPrior(rd);
    let stance: SourceStance;
    if (graderOut) {
      stance = graderOut.stances[i] ?? 'neutral';
    } else {
      stance = prior >= 0.75 ? 'supports' : 'neutral';
    }
    return {
      url: s.provenance.url,
      domain: s.provenance.domain,
      registrable_domain: rd,
      stance,
      domain_prior: prior,
      content_hash: s.provenance.content_hash,
      timestamp: s.provenance.timestamp,
    };
  });

  // Layer (b): ≥2 INDEPENDENT-SOURCE corroboration — count DISTINCT registrable domains per stance.
  const supportDomains = new Set(graded.filter((g) => g.stance === 'supports').map((g) => g.registrable_domain));
  const contradictDomains = new Set(graded.filter((g) => g.stance === 'contradicts').map((g) => g.registrable_domain));
  const corroboration_count = supportDomains.size;
  const contradiction_count = contradictDomains.size;

  const verdict: CragResult['verdict'] = graderOut?.verdict ?? 'UNCERTAIN';
  const confidence = graderOut?.confidence ?? 0;

  let grade: CragGrade;
  let disclosure_flag = false;

  if (contradiction_count >= minCorroboration && contradiction_count > corroboration_count && verdict !== 'TRUE') {
    grade = 'Incorrect';
    reasons.push(
      `Layer (b): ${contradiction_count} independent domain(s) CONTRADICT (≥${minCorroboration}) and none is outweighed by support → Incorrect.`,
    );
  } else if (corroboration_count >= minCorroboration && verdict !== 'FALSE') {
    grade = 'Correct';
    reasons.push(
      `Layer (b): ${corroboration_count} INDEPENDENT domain(s) corroborate (≥${minCorroboration}) [${[...supportDomains].join(', ')}] → Correct.`,
    );
  } else {
    grade = 'Ambiguous';
    disclosure_flag = true;
    if (corroboration_count === 1) {
      reasons.push(
        `Layer (b): only 1 supporting source (${[...supportDomains][0]}) — single-source may NOT reach high confidence → Ambiguous + disclosure.`,
      );
    } else if (corroboration_count === 0 && contradiction_count === 0) {
      reasons.push('Layer (b): no source clearly supports or contradicts → Ambiguous + disclosure.');
    } else {
      reasons.push(
        `Layer (b): support (${corroboration_count}) does not reach ≥${minCorroboration} independent domains, or conflicts with the grader verdict → Ambiguous + disclosure.`,
      );
    }
  }

  return {
    grade,
    verdict,
    confidence,
    corroboration_count,
    contradiction_count,
    disclosure_flag,
    graded_sources: graded,
    dropped_for_provenance: droppedForProvenance,
    dropped_for_denylist: droppedForDenylist,
    reasons,
    grader: graderKind,
    ...(graderModel ? { grader_model: graderModel } : {}),
  };
}
