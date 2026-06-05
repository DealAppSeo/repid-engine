import { db } from '../db';

export async function logLearningEvent(payload: {
  source_agent: string;
  event_type: 'hallucination_caught' | 'hallucination_missed' | 'pattern_discovered' | 'capability_unlocked' | 'mentorship_session' | 'escalation_resolved' | 'challenge_won' | 'challenge_lost' | 'new_fingerprint';
  lesson: string;
  evidence?: any;
  applicable_agents?: string[];
  confidence: number;
}): Promise<void> {
  try {
    const { error } = await db.from('agent_learning_events').insert({
      source_agent: payload.source_agent,
      event_type: payload.event_type,
      lesson: payload.lesson,
      evidence: payload.evidence || {},
      applicable_agents: payload.applicable_agents || [],
      confidence: payload.confidence,
    });

    if (error) {
      console.error('[LearningFeed] Failed to insert learning event:', error.message);
    } else {
      console.log(`[LearningFeed] Inserted event: ${payload.event_type} (${payload.lesson})`);
    }
  } catch (err: any) {
    console.error('[LearningFeed] Error logging learning event:', err.message);
  }
}

export async function handleHallucinationCaught(
  verifierAgent: string,
  claimerAgent: string,
  task: { id: number | string; description?: string; title?: string; task_type?: string; result?: string },
  scoreResult: { hal_score: number; hal_signals?: any }
): Promise<void> {
  try {
    const topic = task.task_type || 'general';
    const signals = scoreResult.hal_signals || {};
    const certainty = signals.certainty_at_claim ?? 0.85;
    const evidence = signals.evidence_quality ?? 0.2;
    const hal_score = scoreResult.hal_score;

    const lesson = `Provider fabricated in ${topic}. Signal signature: high certainty (${certainty}), low evidence (${evidence}).`;

    await logLearningEvent({
      source_agent: verifierAgent,
      event_type: 'hallucination_caught',
      lesson,
      evidence: {
        task_id: task.id,
        hal_score,
        signals,
        prompt: task.description || task.title || '',
        response_excerpt: (task.result || '').substring(0, 200),
      },
      applicable_agents: [claimerAgent], // agent that missed/submitted it
      confidence: 0.95,
    });
  } catch (err: any) {
    console.error('[LearningFeed] Error handling caught hallucination:', err.message);
  }
}
