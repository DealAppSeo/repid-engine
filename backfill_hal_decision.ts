import { db } from './src/db';

async function main() {
  const { data: rows, error } = await db.from('repid_score_events').select('id, hal_score, metadata').is('hal_decision', null).not('hal_score', 'is', null);
  if (error) {
    console.error(error);
    return;
  }
  
  console.log(`Found ${rows.length} rows to backfill.`);
  
  let vetoedCount = 0;
  let flaggedCount = 0;
  let cleanCount = 0;

  for (const row of rows) {
    let decision = 'clean';
    
    const halApproved = row.metadata?.hal_approved;
    const deltaReason = row.metadata?.delta_reason || '';
    const commaSeverity = row.metadata?.hal_signals?.comma_severity;
    
    if (halApproved === false || deltaReason.startsWith('HAL vetoed') || commaSeverity === 'critical') {
      decision = 'vetoed';
      vetoedCount++;
    } else if (row.hal_score >= 0.40) {
      decision = 'flagged';
      flaggedCount++;
    } else {
      cleanCount++;
    }
    
    await db.from('repid_score_events').update({ hal_decision: decision }).eq('id', row.id);
  }
  
  console.log(`Backfill complete. Vetoed: ${vetoedCount}, Flagged: ${flaggedCount}, Clean: ${cleanCount}`);
}

main().catch(console.error);
