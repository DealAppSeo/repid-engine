import { db } from '../src/db';

async function run() {
  console.log("Starting queue drain script...");
  
  // Get count of in_review entries
  const { count: reviewCountBefore } = await db
    .from('peer_verification_queue')
    .select('*', { count: 'exact', head: true })
    .eq('verification_status', 'in_review');
    
  console.log(`Current 'in_review' count: ${reviewCountBefore}`);
  
  const { count: verifiedCountBefore } = await db
    .from('peer_verification_queue')
    .select('*', { count: 'exact', head: true })
    .eq('verification_status', 'verified');
    
  console.log(`Current 'verified' count: ${verifiedCountBefore}`);

  // Fetch the oldest 50 in_review entries
  const { data: entries, error: fetchErr } = await db
    .from('peer_verification_queue')
    .select('id')
    .eq('verification_status', 'in_review')
    .order('id', { ascending: true })
    .limit(50);
    
  if (fetchErr || !entries || entries.length === 0) {
    console.log("No in_review entries found to drain.", fetchErr?.message);
    return;
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
    return;
  }
  
  console.log(`Successfully reset ${updated.length} entries back to 'pending'!`);
}

run().catch(err => {
  console.error("Execution failed:", err);
});
