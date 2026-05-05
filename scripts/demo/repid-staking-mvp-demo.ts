import { createUser, stakeAndBind, withdrawStake, getUserPosition } from '../../src/repid-staking/staking-service';
import { decideTrade } from '../../src/repid-staking/trade-decision';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log("==================================================");
  console.log("    SPRINT R-G: RepID Weighted Staking MVP Demo");
  console.log("==================================================\n");

  const userAddress = '0xAlice1234567890abcdef';

  // STEP 1
  console.log("--- STEP 1: Create user 'alice' at 0xAlice... ---");
  const alice = await createUser(userAddress, 'Alice');
  console.log("Result:", alice);
  await sleep(1000);

  // STEP 2
  console.log("\n--- STEP 2: Show position (empty) ---");
  let pos = await getUserPosition(userAddress);
  console.log("Position:", JSON.stringify(pos, null, 2));
  await sleep(1000);

  // STEP 3
  console.log("\n--- STEP 3: Alice stakes $1000 to SOPHIA (RepID 10000, fraction 1.00) ---");
  const sophiaStake = await stakeAndBind(userAddress, 'sophia', 1000);
  console.log("Stake created:", sophiaStake);
  await sleep(1000);

  // STEP 4
  console.log("\n--- STEP 4: Show updated position -> max trade $1000 ---");
  pos = await getUserPosition(userAddress);
  console.log("Position:", JSON.stringify(pos, null, 2));
  await sleep(1000);

  // STEP 5
  console.log("\n--- STEP 5: SOPHIA attempts $500 -> APPROVED ($500 <= $1000) ---");
  let decision = await decideTrade({ agentId: 'sophia', tradeSizeUSD: 500, userAddress });
  console.log("Trade Decision:", decision);
  console.log("Interpretation: Trade is well within the $1000 max allowed.");
  await sleep(1000);

  // STEP 6
  console.log("\n--- STEP 6: SOPHIA attempts $1500 -> REJECTED rejected_size ($1500 > $1000) ---");
  decision = await decideTrade({ agentId: 'sophia', tradeSizeUSD: 1500, userAddress });
  console.log("Trade Decision:", decision);
  console.log("Interpretation: SOPHIA has max RepID but stake only backs $1000. Rejected.");
  await sleep(1000);

  // STEP 7
  console.log("\n--- STEP 7: Alice stakes $500 to test-newbie (RepID 100, fraction 0.05, max $25) ---");
  const newbieStake = await stakeAndBind(userAddress, 'test-newbie', 500);
  console.log("Stake created:", newbieStake);
  await sleep(1000);

  // STEP 8
  console.log("\n--- STEP 8: test-newbie attempts $50 -> REJECTED ($50 > $25) ---");
  decision = await decideTrade({ agentId: 'test-newbie', tradeSizeUSD: 50, userAddress });
  console.log("Trade Decision:", decision);
  console.log("Interpretation: Agent only has RepID 100 -> 0.05 fraction of $500 = $25 max. Rejected.");
  await sleep(1000);

  // STEP 9
  console.log("\n--- STEP 9: test-newbie attempts $20 -> APPROVED ($20 <= $25) ---");
  decision = await decideTrade({ agentId: 'test-newbie', tradeSizeUSD: 20, userAddress });
  console.log("Trade Decision:", decision);
  console.log("Interpretation: Trade is below the $25 RepID-constrained limit. Approved.");
  await sleep(1000);

  // STEP 10
  console.log("\n--- STEP 10: Show alice's position with both stakes ---");
  pos = await getUserPosition(userAddress);
  console.log("Position:", JSON.stringify(pos, null, 2));
  await sleep(1000);

  // STEP 11
  console.log("\n--- STEP 11: Alice withdraws test-newbie stake ---");
  await withdrawStake(newbieStake.id);
  console.log(`Withdrawn stake ${newbieStake.id}`);
  await sleep(1000);

  // STEP 12
  console.log("\n--- STEP 12: Show final position (only SOPHIA) ---");
  pos = await getUserPosition(userAddress);
  console.log("Position:", JSON.stringify(pos, null, 2));
  await sleep(1000);

  // STEP 13
  console.log("\n--- STEP 13: SQL Queries to Verify Ledger State ---");
  console.log(`
  -- Verify User exists
  SELECT * FROM repid_mvp_users WHERE user_address = '0xAlice1234567890abcdef';
  
  -- Verify Stakes (one active, one withdrawn)
  SELECT * FROM repid_mvp_stakes WHERE user_id = '${alice.id}';
  
  -- Verify Trade Audit Trail
  SELECT * FROM repid_mvp_trade_attempts WHERE user_id = '${alice.id}' ORDER BY created_at ASC;
  `);

  console.log("Demo Complete!");
}

run().catch(console.error);
