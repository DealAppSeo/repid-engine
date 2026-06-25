/**
 * TrustRails config surface (Phase 2) — "the rules are yours to see and tune."
 * Loads a trustrails.config.{yaml,json} into the runtime shapes guard() consumes.
 * Changing this file changes behavior (proven by tests/trustrails-config.test.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  type ClassifierConfig,
  type Tier,
  DEFAULT_CONFIG,
} from '../src/services/consequence-classifier';

export interface TrustRailsConfig {
  version: string;
  classifierConfig: ClassifierConfig;
  /** Tiers that REQUIRE human sign-off (block). Default ['T2']. */
  humanSignOffTiers: Tier[];
}

/** Default lookup order: ./trustrails.config.yaml then the one shipped beside this package. */
export function defaultConfigPath(cwd: string = process.cwd()): string {
  const local = path.join(cwd, 'trustrails.config.yaml');
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, 'trustrails.config.yaml');
}

const VALID_TIERS: ReadonlySet<string> = new Set(['T0', 'T1', 'T2']);

/** Parse a raw object (from YAML/JSON) into a TrustRailsConfig, falling back to DEFAULT_CONFIG. */
export function parseTrustRailsConfig(raw: any): TrustRailsConfig {
  const cons = raw?.consequence ?? {};
  const patterns: string[] = Array.isArray(cons.criticalPathPatterns) ? cons.criticalPathPatterns : null;

  const classifierConfig: ClassifierConfig = {
    prodProjectIds: Array.isArray(cons.prodProjectIds) ? cons.prodProjectIds.map(String) : DEFAULT_CONFIG.prodProjectIds,
    protectedRefs: Array.isArray(cons.protectedRefs) ? cons.protectedRefs.map(String) : DEFAULT_CONFIG.protectedRefs,
    criticalPathPatterns: patterns ? patterns.map((p) => new RegExp(p, 'i')) : DEFAULT_CONFIG.criticalPathPatterns,
    ddlKeywords: Array.isArray(cons.ddlKeywords) ? cons.ddlKeywords.map(String) : DEFAULT_CONFIG.ddlKeywords,
    costT2ThresholdUsd:
      typeof cons.costT2ThresholdUsd === 'number' ? cons.costT2ThresholdUsd : DEFAULT_CONFIG.costT2ThresholdUsd,
  };

  const signOff: string[] = Array.isArray(raw?.humanSignOffTiers) ? raw.humanSignOffTiers : ['T2'];
  const humanSignOffTiers = signOff.filter((t): t is Tier => VALID_TIERS.has(t));

  return {
    version: String(raw?.version ?? 'unknown'),
    classifierConfig,
    humanSignOffTiers: humanSignOffTiers.length ? humanSignOffTiers : ['T2'],
  };
}

/** Load + parse a config file. Throws only if the file is unreadable/invalid YAML. */
export function loadTrustRailsConfig(filePath?: string): TrustRailsConfig {
  const resolved = filePath ?? defaultConfigPath();
  const raw = yaml.load(fs.readFileSync(resolved, 'utf8'));
  return parseTrustRailsConfig(raw);
}
