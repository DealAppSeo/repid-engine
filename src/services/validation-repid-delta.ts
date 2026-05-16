import { db } from '../db';
import { applyValidationEvent } from '../scoring/pipeline';

export async function applyValidationDeltas(
  claimId: string, 
  taskData: any, 
  workerVerdict: string, 
  validators: string[], 
  judgeVerdict: string
) {
  // Claimer Delta
  let claimerDelta = 0;
  let eventType: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' = 'VALIDATION_FAILED';

  if (workerVerdict === 'verified') {
    claimerDelta = 8;
    eventType = 'VALIDATION_PASSED';
  } else if (workerVerdict === 'challenged') {
    claimerDelta = -8;
    eventType = 'VALIDATION_FAILED';
  }

  if (claimerDelta !== 0 && taskData.claimed_by) {
    const { data: claimerInfo } = await db.from('repid_agents').select('id').eq('agent_name', taskData.claimed_by).single();
    if (claimerInfo) {
      await applyValidationEvent(claimerInfo.id, eventType, claimerDelta, {
        task_id: taskData.id,
        claim_id: claimId,
        judgeVerdict
      });
    }
  }

  // Validator Deltas
  // For simplicity, we assume validators array has names.
  // PCP validators who pass when workerVerdict is verified get +4.
  // PCP validators who fail when workerVerdict is challenged get +4.
  // Otherwise penalty -4.
  // Since we don't have per-validator vote mapped easily, we distribute flat for now based on workerVerdict.
  for (const validatorName of validators) {
    const { data: validatorInfo } = await db.from('repid_agents').select('id').eq('agent_name', validatorName).single();
    if (validatorInfo) {
      let valDelta = 4;
      let valType: 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' = 'VALIDATOR_REWARD';
      
      // Real BFT would correlate specific vote to consensus, here we do standard reward if consensus is reached
      if (workerVerdict === 'escalated') {
        valDelta = -4;
        valType = 'VALIDATOR_PENALTY';
      }

      await applyValidationEvent(validatorInfo.id, valType, valDelta, {
        task_id: taskData.id,
        claim_id: claimId,
        consensus_reached: workerVerdict !== 'escalated'
      });
    }
  }
}
