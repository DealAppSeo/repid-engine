import { repIdAttestationService } from '../src/services/repid-attestation';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
  console.log('--- Phase 1: RepID Attestation Test ---');

  // 1. SOPHIA UUID from preflight
  const SOPHIA_ID = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';

  try {
    console.log(`Generating attestation for SOPHIA (${SOPHIA_ID})...`);
    const attestation = await repIdAttestationService.generateAttestation(SOPHIA_ID);
    console.log('Attestation generated:', JSON.stringify(attestation, null, 2));

    console.log('\nVerifying attestation...');
    const result = await repIdAttestationService.verifyAttestation(attestation);
    if (result.valid) {
      console.log('PASS: Attestation is valid.');
    } else {
      console.error('FAIL: Attestation is invalid:', result.reason);
    }

    // Test expiry
    console.log('\nTesting expired attestation...');
    const expiredAttestation = { ...attestation, expires_at: new Date(Date.now() - 1000).toISOString() };
    const expiredResult = await repIdAttestationService.verifyAttestation(expiredAttestation);
    if (!expiredResult.valid && expiredResult.reason === 'Expired') {
      console.log('PASS: Expired attestation rejected.');
    } else {
      console.error('FAIL: Expired attestation not rejected correctly:', expiredResult.reason);
    }

    // Test wrong signature
    console.log('\nTesting invalid signature...');
    const invalidAttestation = { ...attestation, signature: attestation.signature.replace('a', 'b') };
    const invalidResult = await repIdAttestationService.verifyAttestation(invalidAttestation);
    if (!invalidResult.valid) {
      console.log('PASS: Invalid signature rejected:', invalidResult.reason);
    } else {
      console.error('FAIL: Invalid signature was accepted!');
    }

  } catch (e: any) {
    console.error('ERROR during test:', e.message);
  }
}

test();
