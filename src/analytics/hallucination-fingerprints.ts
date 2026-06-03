import { db } from '../db';
import { sendTelegramAlert } from '../routes/telegram';

export interface HallucinationFingerprint {
  pattern_id: string;
  description: string;
  evidence_quality_range: [number, number];
  certainty_range: [number, number];
  uncertainty_range: [number, number];
  scope_match_range: [number, number];
  harm_probability_range: [number, number];
  provider_frequency?: Record<string, number>;
  topic_keywords?: string[];
  detection_rate?: number;
  false_positive_rate?: number;
}

export const SEED_FINGERPRINTS: HallucinationFingerprint[] = [
  {
    pattern_id: 'confident-fabrication',
    description: 'High certainty + low evidence = making stuff up confidently',
    evidence_quality_range: [0, 0.3],
    certainty_range: [0.7, 1.0],
    uncertainty_range: [0, 1.0],
    scope_match_range: [0, 1.0],
    harm_probability_range: [0, 1.0],
    provider_frequency: {},
    topic_keywords: ['factual', 'finance', 'general'],
    detection_rate: 0.92,
    false_positive_rate: 0.05,
  },
  {
    pattern_id: 'knowledge-boundary',
    description: 'Model reaches the edge of its training data without admitting uncertainty',
    evidence_quality_range: [0.3, 0.6],
    certainty_range: [0, 1.0],
    uncertainty_range: [0, 0.3],
    scope_match_range: [0, 1.0],
    harm_probability_range: [0, 1.0],
    provider_frequency: {},
    topic_keywords: ['factual', 'current_events'],
    detection_rate: 0.85,
    false_positive_rate: 0.08,
  },
  {
    pattern_id: 'plausible-but-wrong',
    description: 'All signals look normal but the answer is subtly wrong',
    evidence_quality_range: [0.5, 0.8],
    certainty_range: [0.5, 0.8],
    uncertainty_range: [0, 1.0],
    scope_match_range: [0, 1.0],
    harm_probability_range: [0, 1.0],
    provider_frequency: {},
    topic_keywords: ['reasoning', 'code_review'],
    detection_rate: 0.77,
    false_positive_rate: 0.12,
  },
];

export async function seedFingerprints(): Promise<void> {
  for (const fp of SEED_FINGERPRINTS) {
    const { data } = await db
      .from('hallucination_fingerprints')
      .select('id')
      .eq('pattern_id', fp.pattern_id)
      .maybeSingle();

    if (!data) {
      await db.from('hallucination_fingerprints').insert({
        pattern_id: fp.pattern_id,
        description: fp.description,
        signal_signature: {
          evidence_quality_range: fp.evidence_quality_range,
          certainty_range: fp.certainty_range,
          uncertainty_range: fp.uncertainty_range,
          scope_match_range: fp.scope_match_range,
          harm_probability_range: fp.harm_probability_range,
        },
        provider_frequency: fp.provider_frequency,
        topic_keywords: fp.topic_keywords,
        detection_rate: fp.detection_rate,
        false_positive_rate: fp.false_positive_rate,
        last_seen: new Date().toISOString(),
      });
    }
  }
}

export interface HalClassificationEvent {
  id: string;
  harm_probability: number;
  epistemic_uncertainty: number;
  evidence_quality: number;
  scope_appropriateness: number;
  certainty_at_claim: number;
  provider: string;
  domain: string;
  created_at: string;
}

export async function runFingerprintClustering(): Promise<void> {
  // 1. Fetch recent score events representing caught hallucinations (last 7 days)
  const { data: events } = await db
    .from('repid_score_events')
    .select('id, metadata, llm_provider, task_domain, created_at')
    .eq('hallucination_caught', true)
    .gt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

  if (!events || events.length < 5) return;

  const classificationEvents: HalClassificationEvent[] = events
    .map((e: any) => {
      const sigs = e.metadata?.hal_signals || {};
      return {
        id: String(e.id),
        harm_probability: Number(sigs.harm_probability ?? 0),
        epistemic_uncertainty: Number(sigs.epistemic_uncertainty ?? 0),
        evidence_quality: Number(sigs.evidence_quality ?? 0),
        scope_appropriateness: Number(sigs.scope_appropriateness ?? 0),
        certainty_at_claim: Number(sigs.certainty_at_claim ?? 0),
        provider: String(e.llm_provider || 'unknown'),
        domain: String(e.task_domain || 'general'),
        created_at: e.created_at,
      };
    });

  // 2. Perform simple distance-based clustering
  const clusters: HalClassificationEvent[][] = [];
  const visited = new Set<string>();

  for (const e1 of classificationEvents) {
    if (visited.has(e1.id)) continue;
    const cluster: HalClassificationEvent[] = [e1];
    visited.add(e1.id);

    for (const e2 of classificationEvents) {
      if (visited.has(e2.id)) continue;
      const dist = Math.sqrt(
        Math.pow(e1.harm_probability - e2.harm_probability, 2) +
        Math.pow(e1.epistemic_uncertainty - e2.epistemic_uncertainty, 2) +
        Math.pow(e1.evidence_quality - e2.evidence_quality, 2) +
        Math.pow(e1.scope_appropriateness - e2.scope_appropriateness, 2) +
        Math.pow(e1.certainty_at_claim - e2.certainty_at_claim, 2)
      );

      if (dist < 0.15) {
        cluster.push(e2);
        visited.add(e2.id);
      }
    }

    if (cluster.length >= 5) {
      clusters.push(cluster);
    }
  }

  // 3. Process clusters of size >= 5 to see if they match/define a new pattern
  for (const cluster of clusters) {
    // Determine bounds
    const harms = cluster.map(c => c.harm_probability);
    const uncertains = cluster.map(c => c.epistemic_uncertainty);
    const evidences = cluster.map(c => c.evidence_quality);
    const scopes = cluster.map(c => c.scope_appropriateness);
    const certainties = cluster.map(c => c.certainty_at_claim);

    const minHarm = Math.min(...harms);
    const maxHarm = Math.max(...harms);
    const minUncertain = Math.min(...uncertains);
    const maxUncertain = Math.max(...uncertains);
    const minEvidence = Math.min(...evidences);
    const maxEvidence = Math.max(...evidences);
    const minScope = Math.min(...scopes);
    const maxScope = Math.max(...scopes);
    const minCertainty = Math.min(...certainties);
    const maxCertainty = Math.max(...certainties);

    // Domain and providers tally
    const domains = cluster.map(c => c.domain);
    const domainFreq = domains.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {} as Record<string, number>);
    const primaryDomain = Object.entries(domainFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';

    const providers = cluster.map(c => c.provider);
    const providerFreq = providers.reduce((acc, p) => { acc[p] = (acc[p] || 0) + 1; return acc; }, {} as Record<string, number>);

    // Generate unique pattern ID
    const patternId = `auto-pattern-${primaryDomain}-${Math.round(minEvidence * 10)}-${Math.round(minCertainty * 10)}`;

    // Check if duplicate
    const { data: existing } = await db
      .from('hallucination_fingerprints')
      .select('id')
      .eq('pattern_id', patternId)
      .maybeSingle();

    if (!existing) {
      // Save new fingerprint to DB
      await db.from('hallucination_fingerprints').insert({
        pattern_id: patternId,
        description: `Auto-generated pattern for domain ${primaryDomain}`,
        signal_signature: {
          evidence_quality_range: [minEvidence, maxEvidence],
          certainty_range: [minCertainty, maxCertainty],
          uncertainty_range: [minUncertain, maxUncertain],
          scope_match_range: [minScope, maxScope],
          harm_probability_range: [minHarm, maxHarm],
        },
        provider_frequency: providerFreq,
        topic_keywords: [primaryDomain],
        detection_rate: 0.8,
        false_positive_rate: 0.05,
        sample_count: cluster.length,
        last_seen: new Date().toISOString(),
      });

      // Write learning event
      const lesson = `New hallucination pattern detected in ${primaryDomain} domain. Signal signature: evidence [${minEvidence.toFixed(2)}-${maxEvidence.toFixed(2)}], certainty [${minCertainty.toFixed(2)}-${maxCertainty.toFixed(2)}]. Pattern: ${patternId}.`;
      await db.from('agent_learning_events').insert({
        source_agent: 'system',
        event_type: 'new_fingerprint',
        lesson,
        evidence: {
          pattern_id: patternId,
          cluster_size: cluster.length,
          minHarm, maxHarm,
          minEvidence, maxEvidence,
          minCertainty, maxCertainty,
          primaryDomain,
          providers: providerFreq,
        },
        confidence: 0.9,
      });

      // Telegram alert
      await sendTelegramAlert(`🚨 <b>New Hallucination Pattern Detected</b>\nDomain: ${primaryDomain}\nID: <code>${patternId}</code>\nCluster size: ${cluster.length} events\nSignature: Evidence [${minEvidence.toFixed(2)}-${maxEvidence.toFixed(2)}], Certainty [${minCertainty.toFixed(2)}-${maxCertainty.toFixed(2)}].`);
    }
  }
}
