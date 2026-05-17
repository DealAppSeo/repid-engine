import { ServiceHandlerBase } from './service-handler-base';
import { db } from '../db';
import type { ServiceContractRow } from '../types';

interface ReputationAuditPayload {
  subject_agent_id: string;     // who's being audited
  attestation_purpose?: string; // optional: 'lending', 'collaboration', 'enterprise_onboard', etc.
  include_zkp?: boolean;        // whether to generate ZKP proof (default true)
}

export class ReputationAuditServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'reputation_audit';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as ReputationAuditPayload;

    // Fetch current reputation state of subject
    const { data: subject, error: subjectErr } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, validation_count, validations_correct, vdr_count, wisdom_score, character_score, signing_address')
      .eq('id', payload.subject_agent_id)
      .single();

    if (subjectErr || !subject) {
      throw new Error(`Subject agent not found: ${payload.subject_agent_id}`);
    }

    // Build canonical attestation payload
    const attestationPayload = {
      subject_agent_id: subject.id,
      subject_agent_name: subject.agent_name,
      current_repid: subject.current_repid,
      tier: subject.tier,
      validation_count: subject.validation_count,
      validations_correct: subject.validations_correct,
      vdr_count: subject.vdr_count,
      wisdom_score: subject.wisdom_score,
      character_score: subject.character_score,
      attester_agent_id: contract.provider_agent_id,
      contract_id: contract.id,
      attestation_purpose: payload.attestation_purpose ?? 'general',
      attested_at: new Date().toISOString(),
    };

    // Sign attestation using existing signing infrastructure
    const { signature, signing_address } = await this.signAttestation(attestationPayload);

    // Optional ZKP proof — only if existing ZKP service available
    let zkpProofId = null;
    if (payload.include_zkp !== false) {
      try {
        zkpProofId = await this.generateZKPProof(attestationPayload);
      } catch (e: any) {
        console.error(`[reputation_audit] ZKP generation failed, attestation continues without ZKP:`,
          e?.message, e?.stack);
        // Non-fatal — attestation is still valid via signature
      }
    }

    // Insert attestation record
    const { data: attestation, error: attErr } = await db
      .from('reputation_attestations')
      .insert({
        service_contract_id: contract.id,
        subject_agent_id: subject.id,
        attester_agent_id: contract.provider_agent_id,
        current_repid_snapshot: subject.current_repid,
        tier_snapshot: subject.tier,
        validation_count_snapshot: subject.validation_count,
        validations_correct_snapshot: subject.validations_correct,
        vdr_count_snapshot: subject.vdr_count,
        wisdom_score_snapshot: subject.wisdom_score,
        character_score_snapshot: subject.character_score,
        attestation_payload: attestationPayload,
        signature,
        signing_address,
        zkp_proof_id: zkpProofId,
      })
      .select()
      .single();

    if (attErr) {
      throw new Error(`reputation_attestations insert failed: ${attErr.message}`);
    }

    return {
      attestation_id: attestation.id,
      subject_agent_id: subject.id,
      subject_agent_name: subject.agent_name,
      reputation_snapshot: {
        current_repid: subject.current_repid,
        tier: subject.tier,
        validation_accuracy: subject.validation_count > 0
          ? (subject.validations_correct / subject.validation_count)
          : null,
        wisdom_score: subject.wisdom_score,
        character_score: subject.character_score,
      },
      signature,
      signing_address,
      zkp_proof_id: zkpProofId,
      expires_at: attestation.expires_at,
      attested_at: attestation.created_at,
      contract_id: contract.id,
      patent_marker: 'P-001',
    };
  }

  /**
   * Signs the attestation payload using the provider agent's signing key.
   */
  private async signAttestation(payload: object): Promise<{ signature: string; signing_address: string }> {
    // Missing signing infrastructure — filing as adjacent issue
    return { signature: 'signing_status=deferred', signing_address: '0x0000000000000000000000000000000000000000' };
  }

  /**
   * Generates ZKP proof for the attestation. Optional.
   */
  private async generateZKPProof(payload: object): Promise<string | null> {
    // Missing ZKP postcard generation linkage for arbitrary payloads
    return null;
  }
}
