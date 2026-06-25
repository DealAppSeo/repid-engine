/**
 * REFERENCE hardened classifier — mirrors CC r5-harden spec for red-team delta only.
 * Replace with feat/cc-2026-06-24-r5-harden when CC lands; NOT production code.
 */
import {
  type Action,
  type Classification,
  type ClassifierConfig,
  DEFAULT_CONFIG,
  evaluateRules,
  maxTier,
  noopLlmSuggest,
  ruleFloor,
  type RuleHit,
  type Tier,
} from '../../services/consequence-classifier';

export interface HardenedContext {
  cumulativeSpendUsd: number;
  spendCapUsd: number;
}

export function createHardenedContext(spendCapUsd = 1.0): HardenedContext {
  return { cumulativeSpendUsd: 0, spendCapUsd };
}

export function normalizeGitRef(ref: string): string {
  let r = ref.trim().toLowerCase();
  r = r.replace(/^refs\/heads\//, '');
  r = r.replace(/^origin\//, '');
  r = r.replace(/^remotes\/origin\//, '');
  return r;
}

export function normalizeSqlBlob(sql: string): string {
  let s = sql.toLowerCase();
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  s = s.replace(/--.*$/gm, ' ');
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ');
  try {
    if (/^[a-f0-9]{16,}$/i.test(s.trim())) {
      s += ' ' + Buffer.from(s.trim(), 'hex').toString('utf8').toLowerCase();
    }
  } catch {
    /* ignore */
  }
  try {
    if (s.includes('%')) s += ' ' + decodeURIComponent(s);
  } catch {
    /* ignore */
  }
  return s;
}

export function scanSqlForDdl(sql: string, config: ClassifierConfig = DEFAULT_CONFIG): string | null {
  const normalized = normalizeSqlBlob(sql);
  if (/dr\s*['"]\s*\|\|\s*['"]\s*op/.test(normalized)) return 'drop';
  for (const kw of config.ddlKeywords) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(normalized)) return kw;
  }
  return null;
}

export function sensitiveMarkersInBlob(blob: string, config: ClassifierConfig = DEFAULT_CONFIG): string | null {
  const lc = blob.toLowerCase();
  for (const id of config.prodProjectIds) {
    if (lc.includes(id.toLowerCase())) return `prod-id:${id}`;
  }
  if (/migrations\//i.test(lc) || /migrations\\/i.test(lc)) return 'migrations-path';
  if (/(^|\/)\\.env/i.test(lc)) return 'env-surface';
  return null;
}

export function classifyActionHardened(
  action: Action,
  ctx: HardenedContext,
  opts: { config?: ClassifierConfig } = {}
): Classification {
  const config = opts.config ?? DEFAULT_CONFIG;
  const preprocessed: Action = {
    ...action,
    git: action.git
      ? { ...action.git, targetRef: action.git.targetRef ? normalizeGitRef(action.git.targetRef) : action.git.targetRef }
      : action.git,
  };

  const hits: RuleHit[] = [...evaluateRules(preprocessed, config)];

  const sqlSources = [action.sql, action.description].filter(Boolean) as string[];
  for (const sql of sqlSources) {
    const kw = scanSqlForDdl(sql, config);
    if (kw && !hits.some((h) => h.ruleId === 'T2_DDL')) {
      hits.push({ ruleId: 'T2_DDL', tier: 'T2', reason: `DDL keyword "${kw}" (kind-agnostic scan)` });
    }
  }

  const blob = [
    action.description,
    action.sql,
    action.projectId,
    ...(action.paths ?? []),
    action.git?.targetRef,
  ]
    .filter(Boolean)
    .join(' ');
  const marker = sensitiveMarkersInBlob(blob, config);
  if (marker && !hits.some((h) => h.tier === 'T2')) {
    hits.push({ ruleId: 'T2_CRITICAL_PATH', tier: 'T2', reason: `description-aware marker: ${marker}` });
  }

  if (typeof action.costUsd === 'number' && action.costUsd > 0) {
    ctx.cumulativeSpendUsd += action.costUsd;
    if (ctx.cumulativeSpendUsd >= ctx.spendCapUsd) {
      hits.push({
        ruleId: 'T2_HIGH_COST',
        tier: 'T2',
        reason: `aggregate spend $${ctx.cumulativeSpendUsd.toFixed(2)} ≥ cap $${ctx.spendCapUsd}`,
      });
    }
  }

  const floor = ruleFloor(hits);
  const suggested = noopLlmSuggest(action);
  const tier: Tier = suggested ? maxTier(floor.tier, suggested) : floor.tier;

  return {
    tier,
    ruleFloor: floor.tier,
    hits,
    failSafe: floor.failSafe,
    llmSuggested: null,
  };
}