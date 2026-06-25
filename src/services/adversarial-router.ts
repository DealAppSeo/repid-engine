/**
 * Adversarial chamber router — governance spec v0.3 §4.
 * Router (not proposer) selects templates, enforces lineage diversity,
 * scores evidence-gated objections via non-LLM verifier.
 */
import fs from 'fs';
import path from 'path';
import {
  type ActionClass,
  type AdversarialTemplate,
  type EvidenceKind,
  getTemplateForActionClass,
  lineagesAreDiverse,
  TEMPLATE_LIBRARY_VERSION,
} from '../config/adversarial-templates';
import { classifyAction, type Action as ClassifierAction } from './consequence-classifier';

/** Pluggable classifier — wires to CC's consequence-classifier when present. */
export interface ConsequenceClassifier {
  classifyAction(action: ProposedAction): 'T0' | 'T1' | 'T2';
}

export interface ProposedAction {
  id: string;
  actionClass: ActionClass;
  artifactSummary: string;
  /** Paths/refs only — no proposer chain-of-thought (context firewall). */
  artifactRefs?: string[];
}

export interface ChamberParticipant {
  agentId: string;
  provider: string;
  lineageProvider: string;
  certainty?: number;
  contextHash?: string;
}

export type EvidenceCitation = {
  kind: EvidenceKind;
  value: string;
};

export interface AdversarialObjection {
  summary: string;
  citations: EvidenceCitation[];
  agreesActionIsWrong?: boolean;
}

export type VerifiedCitation = EvidenceCitation & {
  verified: boolean;
  verifyDetail: string;
};

export type ChamberDecision =
  | { outcome: 'escalate'; reason: string; templateId: string }
  | { outcome: 'proceed'; reason: string; templateId: string }
  | { outcome: 'tie-break'; reason: string; templateId: string; thirdLineageRequired: true };

export interface AdversarialRouterOptions {
  classifier?: ConsequenceClassifier;
  repoRoot?: string;
}

/** Map chamber ProposedAction → CC infra-bound Action for classification. */
export function proposedToClassifierAction(proposed: ProposedAction): ClassifierAction {
  switch (proposed.actionClass) {
    case 'merge':
      return {
        kind: 'git',
        git: { operation: 'merge', targetRef: 'feat/integration-branch' },
        paths: proposed.artifactRefs,
        description: proposed.artifactSummary,
      };
    case 'prod-config':
      return {
        kind: 'platform',
        platform: { name: 'railway', isProd: false },
        paths: proposed.artifactRefs,
        description: proposed.artifactSummary,
      };
    case 'spend':
      return {
        kind: 'spend',
        costUsd: 0.5,
        description: proposed.artifactSummary,
      };
    default:
      return { kind: 'shell', description: proposed.artifactSummary };
  }
}

/** Real CC classifier wired through the adapter (replaces stub default). */
export const consequenceClassifierAdapter: ConsequenceClassifier = {
  classifyAction(proposed) {
    return classifyAction(proposedToClassifierAction(proposed)).tier;
  },
};

const CI_RUN_RE = /^\d{8,}$/;
const TEST_NAME_RE = /^[a-zA-Z0-9_./-]+\.test\.(ts|js)$/;
const GIT_DIFF_RE = /^[0-9a-f]{7,40}(:[a-zA-Z0-9_./-]+)?$/;

/** Non-LLM evidence verifier — spec §4 LOCK A2. */
export function verifyCitation(
  citation: EvidenceCitation,
  repoRoot: string = process.cwd()
): VerifiedCitation {
  const v = citation.value.trim();
  switch (citation.kind) {
    case 'ci_run_id':
      return {
        ...citation,
        verified: CI_RUN_RE.test(v),
        verifyDetail: CI_RUN_RE.test(v) ? 'ci_run_id format ok' : 'invalid ci_run_id format',
      };
    case 'failing_test_name': {
      const rel = v.replace(/\\/g, '/');
      const candidates = [
        path.join(repoRoot, rel),
        path.join(repoRoot, 'tests', rel),
        path.join(repoRoot, rel.startsWith('tests/') ? rel : `tests/${rel}`),
      ];
      const exists = candidates.some((p) => fs.existsSync(p));
      return {
        ...citation,
        verified: TEST_NAME_RE.test(rel) && exists,
        verifyDetail: exists ? 'test file exists' : 'test file not found in repo',
      };
    }
    case 'schema_query_result':
      return {
        ...citation,
        verified: v.length >= 8 && (v.includes('table') || v.includes('column') || v.startsWith('{')),
        verifyDetail: 'schema_query_result shape ok',
      };
    case 'git_diff_ref': {
      const ok = GIT_DIFF_RE.test(v);
      return {
        ...citation,
        verified: ok,
        verifyDetail: ok ? 'git_diff_ref format ok' : 'invalid git_diff_ref',
      };
    }
    default:
      return { ...citation, verified: false, verifyDetail: 'unknown evidence kind' };
  }
}

export function verifyObjection(
  objection: AdversarialObjection,
  repoRoot?: string
): { allVerified: boolean; citations: VerifiedCitation[]; unverifiedCount: number } {
  const citations = objection.citations.map((c) => verifyCitation(c, repoRoot));
  const unverifiedCount = citations.filter((c) => !c.verified).length;
  return {
    allVerified: citations.length > 0 && unverifiedCount === 0,
    citations,
    unverifiedCount,
  };
}

export function scoreAttack(
  objection: AdversarialObjection,
  repoRoot?: string
): 'substantive' | 'weak' | 'unverified' | 'empty' {
  if (!objection.citations.length) return 'empty';
  const { allVerified, citations } = verifyObjection(objection, repoRoot);
  if (!allVerified) return 'unverified';
  const hasSubstance = objection.summary.trim().length >= 12 && citations.length >= 1;
  return hasSubstance ? 'substantive' : 'weak';
}

export class AdversarialRouter {
  private classifier: ConsequenceClassifier;
  private repoRoot: string;

  constructor(opts: AdversarialRouterOptions = {}) {
    this.classifier = opts.classifier ?? consequenceClassifierAdapter;
    this.repoRoot = opts.repoRoot ?? process.cwd();
  }

  /** Router selects template — proposer does not. */
  selectTemplate(action: ProposedAction): AdversarialTemplate {
    return getTemplateForActionClass(action.actionClass);
  }

  enforceLineageDiversity(proposer: ChamberParticipant, adversary: ChamberParticipant): void {
    if (!lineagesAreDiverse(proposer.lineageProvider, adversary.lineageProvider)) {
      throw new Error(
        `lineage diversity violation: proposer=${proposer.lineageProvider} adversary=${adversary.lineageProvider}`
      );
    }
    if (
      proposer.contextHash &&
      adversary.contextHash &&
      proposer.contextHash === adversary.contextHash
    ) {
      throw new Error('A1 tripwire: identical context-hash between proposer and adversary');
    }
  }

  decideT1(
    action: ProposedAction,
    proposer: ChamberParticipant,
    adversary: ChamberParticipant,
    objection: AdversarialObjection
  ): ChamberDecision {
    const template = this.selectTemplate(action);
    this.enforceLineageDiversity(proposer, adversary);

    if (objection.agreesActionIsWrong) {
      return {
        outcome: 'tie-break',
        reason: 'adversary agrees action is wrong — third lineage required before HITL',
        templateId: template.id,
        thirdLineageRequired: true,
      };
    }

    const attack = scoreAttack(objection, this.repoRoot);
    if (attack === 'unverified' || attack === 'empty') {
      return {
        outcome: 'escalate',
        reason: `unverified or empty objection (${attack})`,
        templateId: template.id,
      };
    }
    if (attack === 'substantive') {
      return {
        outcome: 'escalate',
        reason: 'verified substantive objection landed',
        templateId: template.id,
      };
    }
    return {
      outcome: 'proceed',
      reason: 'weak attack with verified citations — action survived scrutiny',
      templateId: template.id,
    };
  }

  /** Full chamber entry — returns classifier tier when wired. */
  runChamber(
    action: ProposedAction,
    proposer: ChamberParticipant,
    adversary: ChamberParticipant,
    objection: AdversarialObjection
  ): { tier: 'T0' | 'T1' | 'T2'; decision?: ChamberDecision; templateVersion: string } {
    const tier = this.classifier.classifyAction(action);
    if (tier !== 'T1') {
      return { tier, templateVersion: TEMPLATE_LIBRARY_VERSION };
    }
    const decision = this.decideT1(action, proposer, adversary, objection);
    return { tier, decision, templateVersion: TEMPLATE_LIBRARY_VERSION };
  }
}

/** Isolated chamber tests only — production path uses consequenceClassifierAdapter. */
export const stubConsequenceClassifier: ConsequenceClassifier = {
  classifyAction: () => 'T1',
};