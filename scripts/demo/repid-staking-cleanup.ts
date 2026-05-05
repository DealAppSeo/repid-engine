import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function cleanup() {
  const userAddress = '0xAlice1234567890abcdef';
  console.log(`Cleaning up demo data for user: ${userAddress}`);

  const { data: user, error: userErr } = await supabase
    .from('repid_mvp_users')
    .select('id')
    .eq('user_address', userAddress)
    .single();

  if (userErr || !user) {
    console.log("User not found, nothing to clean up.");
    return;
  }

  const userId = user.id;

  // Delete trade attempts
  const { error: tErr } = await supabase.from('repid_mvp_trade_attempts').delete().eq('user_id', userId);
  if (tErr) console.error("Error deleting trade attempts:", tErr.message);
  else console.log("Deleted trade attempts.");

  // Delete stakes
  const { error: sErr } = await supabase.from('repid_mvp_stakes').delete().eq('user_id', userId);
  if (sErr) console.error("Error deleting stakes:", sErr.message);
  else console.log("Deleted stakes.");

  // Delete user
  const { error: uErr } = await supabase.from('repid_mvp_users').delete().eq('id', userId);
  if (uErr) console.error("Error deleting user:", uErr.message);
  else console.log("Deleted user.");

  console.log("Cleanup complete!");
}

cleanup().catch(console.error);
