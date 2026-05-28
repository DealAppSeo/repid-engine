import { db } from '../src/db';

async function drainBatch() {
  // Get count of in_review entries
  const { count: reviewCountBefore } = await db
    .from('peer_verification_queue')
    .select('*', { count: 'exact', head: true })
    .eq('verification_status', 'in_review');
    
  console.log(`[${new Date().toISOString()}] Current 'in_review' count: ${reviewCountBefore}`);
  
  const { count: verifiedCountBefore } = await db
    .from('peer_verification_queue')
    .select('*', { count: 'exact', head: true })
    .in('verification_status', ['verified', 'disputed']);
    
  console.log(`Current 'verified/disputed' count: ${verifiedCountBefore}`);

  // Fetch the oldest 50 in_review entries
  const { data: entries, error: fetchErr } = await db
    .from('peer_verification_queue')
    .select('id')
    .eq('verification_status', 'in_review')
    .order('id', { ascending: true })
    .limit(50);
    
  if (fetchErr || !entries || entries.length === 0) {
    console.log("No in_review entries found to drain.", fetchErr?.message);
    return false;
  }
  
  const idsToDrain = entries.map(e => e.id);
  console.log(`Draining ${idsToDrain.length} entries: ${idsToDrain.join(', ')}`);
  
  const { data: updated, error: updateErr } = await db
    .from('peer_verification_queue')
    .update({ verification_status: 'pending' })
    .in('id', idsToDrain)
    .select('id');
    
  if (updateErr) {
    console.error("Failed to update status to pending:", updateErr.message);
    return false;
  }
  
  console.log(`Successfully reset ${updated.length} entries back to 'pending'!`);
  return true;
}

async function main() {
  console.log("Starting queue drain loop: 30 batches of 50 entries, 60 seconds apart...");
  for (let i = 0; i < 30; i++) {
    console.log(`\n=== Batch ${i + 1}/30 ===`);
    const hasMore = await drainBatch();
    if (!hasMore && i > 0) {
      console.log("No more entries to drain. Exiting loop.");
      break;
    }
    if (i < 29) {
      console.log("Waiting 60 seconds before next batch...");
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }
  console.log("Queue drain loop complete!");
}

main().catch(err => {
  console.error("Execution failed:", err);
});
