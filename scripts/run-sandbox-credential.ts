import * as dotenv from 'dotenv';
import axios from 'axios';
import { pgQuery } from '../src/db/direct-pg';

dotenv.config();

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

async function main() {
  const melUuid = '942860a6-e26f-4334-ae94-b7c1abed1e8c';
  const conservatorAddress = '0xdf6b8215D193b11B4903d223729c3CF7A6de271d';

  console.log("==========================================================");
  console.log(`SANDBOX CREDENTIAL ISSUANCE & VERIFICATION RUNNER`);
  console.log(`Agent UUID (Mel): ${melUuid}`);
  console.log(`Conservator Address: ${conservatorAddress}`);
  console.log("==========================================================");

  try {
    // 1. Verify agent exists in DB
    const agentRes = await pgQuery(`SELECT id, agent_name, current_repid, domain_accuracy FROM repid_agents WHERE id = $1`, [melUuid]);
    if (!agentRes || agentRes.length === 0) {
      console.error(`ERROR: Mel agent with UUID ${melUuid} not found in database.`);
      return;
    }
    console.log(`Found agent in DB: ${agentRes[0].agent_name} (RepID: ${agentRes[0].current_repid})`);
    console.log(`Domain Accuracy:`, JSON.stringify(agentRes[0].domain_accuracy));

    // 2. Call /credentials/issue
    console.log(`\nIssuing credential via POST /credentials/issue...`);
    const issueRes = await axios.post(`${BASE_URL}/credentials/issue`, {
      agent_id: melUuid,
      conservator_address: conservatorAddress
    });

    if (issueRes.status === 201) {
      const issueData = issueRes.data;
      console.log(`SUCCESS! Credential Issued:`);
      console.log(`Credential ID: ${issueData.credential_id}`);
      console.log(`Holder DID: ${issueData.holder_did}`);
      console.log(`Nullifier: ${issueData.nullifier}`);
      console.log(`Binding Hash: ${issueData.binding_hash}`);

      // 3. Call /credentials/verify
      console.log(`\nVerifying credential via POST /credentials/verify...`);
      const verifyRes = await axios.post(`${BASE_URL}/credentials/verify`, {
        credential_id: issueData.credential_id
      });

      if (verifyRes.status === 200) {
        console.log(`SUCCESS! Credential Verified:`, JSON.stringify(verifyRes.data, null, 2));
      } else {
        console.error(`Failed to verify credential:`, verifyRes.data);
      }
    } else {
      console.error(`Failed to issue credential:`, issueRes.data);
    }
  } catch (err: any) {
    console.error(`ERROR running credential flow:`, err.response?.data || err.message);
  }
  console.log("==========================================================");
}

main().catch(console.error);
