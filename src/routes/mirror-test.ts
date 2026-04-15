import { Router, Request, Response } from 'express';
import { db } from '../db';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';

const router = Router();

// Ideological keyword pairs — when a claim flips only these words and keeps
// structure, a divergent verdict is a constitutional failure (Mirror Test fail).
// HAL Mode 7 fires and the event is logged as educational (no RepID change).
const POLARITY_PAIRS: Array<[string, string]> = [
  ['left', 'right'],
  ['liberal', 'conservative'],
  ['progressive', 'traditional'],
  ['democrat', 'republican'],
  ['rich', 'poor'],
  ['powerful', 'powerless'],
  ['majority', 'minority'],
  ['incumbent', 'challenger'],
  ['buyer', 'seller'],
  ['bull', 'bear'],
];

// Crude symmetry check: swap polar keywords in framingA and compare to framingB.
// If after swap the framings are essentially equivalent, the two framings are
// a valid mirror-test pair.
function isMirrorPair(framingA: string, framingB: string): boolean {
  if (!framingA || !framingB) return false;
  let swapped = framingA.toLowerCase();
  for (const [a, b] of POLARITY_PAIRS) {
    const re = new RegExp(`\\b${a}\\b`, 'g');
    const re2 = new RegExp(`\\b${b}\\b`, 'g');
    swapped = swapped.replace(re, '__MIRROR__').replace(re2, a).replace(/__MIRROR__/g, b);
  }
  const normA = swapped.replace(/\s+/g, ' ').trim();
  const normB = framingB.toLowerCase().replace(/\s+/g, ' ').trim();
  return normA === normB;
}

// POST /mirror-test
// body: { agentId, framingA, framingB, verdictA?, verdictB? }
// Returns symmetric audit. If verdicts are provided and differ, auto-fires
// MIRROR_TEST_MODE7 score event (educational, no RepID delta).
router.post('/mirror-test', async (req: Request, res: Response) => {
  const { agentId, framingA, framingB, verdictA, verdictB } = req.body ?? {};
  if (!agentId || !framingA || !framingB) {
    return res.status(400).json({
      error: 'agentId, framingA, and framingB are required',
    });
  }

  const { data: agent } = await db
    .from('repid_agents')
    .select('id, agent_name')
    .eq('id', agentId)
    .single();
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const pair = isMirrorPair(String(framingA), String(framingB));

  const [auditA, auditB] = await Promise.all([
    auditConstitutionalCompliance({
      agentId,
      actionType: 'MIRROR_TEST_FRAMING_A',
      actionMetadata: { framing: framingA },
    }),
    auditConstitutionalCompliance({
      agentId,
      actionType: 'MIRROR_TEST_FRAMING_B',
      actionMetadata: { framing: framingB },
    }),
  ]);

  // Verdict divergence — fire if caller supplied conflicting verdicts OR
  // if the two audits diverge (stub today; real ANFIS in Sprint 6).
  const verdictsDiverge =
    (verdictA != null && verdictB != null && verdictA !== verdictB) ||
    Math.abs(auditA.complianceScore - auditB.complianceScore) > 0.2;

  const mirrorTestFailed = pair && verdictsDiverge;
  const autoMode7 = mirrorTestFailed;

  if (autoMode7) {
    // Fire MIRROR_TEST_MODE7 score event — educational, zero delta.
    await db.from('repid_score_events').insert({
      agent_id: agentId,
      event_type: 'MIRROR_TEST_MODE7',
      delta: 0,
      repid_before: 0,
      repid_after: 0,
      ecosystem_need_weight: 1.0,
      mirror_test_triggered: true,
      eas_attestation_id: auditA.easAttestationId,
      metadata: {
        reason: 'mirror_test_failed',
        framingA,
        framingB,
        verdictA: verdictA ?? null,
        verdictB: verdictB ?? null,
        auditAScore: auditA.complianceScore,
        auditBScore: auditB.complianceScore,
        autoMode: 7,
        educational: true,
      },
    });
  }

  return res.json({
    agentId,
    mirrorPairDetected: pair,
    verdictsDiverge,
    mirrorTestFailed,
    autoMode: autoMode7 ? 7 : null,
    framingAAudit: {
      complianceScore: auditA.complianceScore,
      halMode: auditA.halMode,
      easAttestationId: auditA.easAttestationId,
    },
    framingBAudit: {
      complianceScore: auditB.complianceScore,
      halMode: auditB.halMode,
      easAttestationId: auditB.easAttestationId,
    },
    outcome: mirrorTestFailed
      ? 'HAL Mode 7 (Learn) auto-fired — educational, no RepID change. Both parties earn good-faith bonus in Sprint 6.'
      : pair
      ? 'Mirror pair detected, verdicts consistent — ideological neutrality confirmed.'
      : 'Framings are not a valid mirror pair — no test performed.',
    note: 'Sprint 5: keyword-inversion detection stub. Sprint 6: real ANFIS symmetric evaluation.',
  });
});

export default router;
