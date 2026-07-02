import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

// Parse TruthfulQA artifact (markdown format)
function parseTruthfulQA(content: string): any[] {
  const items: any[] = [];
  const sections = content.split(/### Item TQA-/);
  
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i]!;
    const itemNum = section.match(/^(\d+)/)?.[1];
    if (!itemNum) continue;
    
    const tqaId = `TQA-${itemNum.padStart(3, '0')}`;
    const question = section.match(/\*\*Question:\*\*\s*(.*)/)?.[1]?.trim();
    const correctAnswer = section.match(/\*\*Correct Answer:\*\*\s*(.*)/)?.[1]?.trim();
    const labelMatch = section.match(/\*\*Truthful Label:\*\*\s*(TRUE|FALSE)/)?.[1]?.trim();
    const category = section.match(/\*\*Category:\*\*\s*(.*)/)?.[1]?.trim() || 'Misconceptions';
    const provenance = section.match(/\*\*Provenance:\*\*\s*(.*)/)?.[1]?.trim();
    
    if (!question || !correctAnswer || !labelMatch || !provenance) {
      console.warn(`[TruthfulQA] Skipping item ${tqaId} due to missing fields`);
      continue;
    }
    
    const urlMatch = provenance.match(/source=(https?:\/\/\S+)/)?.[1];
    const itemIdMatch = provenance.match(/item_id=(\d+)/)?.[1] || itemNum;
    const url = urlMatch || 'https://github.com/sylinrl/TruthfulQA/blob/main/TruthfulQA.csv';
    
    const isHallucinated = labelMatch === 'FALSE';
    
    // Combine question and answer for prompt_text to provide full context to the fact-checker
    const promptText = `Question: ${question}\nAnswer: ${correctAnswer}`;
    
    items.push({
      prompt_text: promptText,
      expected_hallucination: isHallucinated,
      expected_decision: isHallucinated ? 'veto' : 'pass',
      category: 'factual',
      difficulty: 'med',
      notes: `Dataset: TruthfulQA | ID: ${tqaId} (item_id=${itemIdMatch}) | URL: ${url}`,
      source: 'external-truthfulqa-20260606'
    });
  }
  return items;
}

// Parse FEVER artifact (JSON format)
function parseFEVER(content: string): any[] {
  const items: any[] = [];
  const raw = JSON.parse(content);
  
  for (const item of raw) {
    if (item.verdict === 'NOTENOUGHINFO') {
      console.log(`[FEVER] Quarantining NOTENOUGHINFO item: ${item.id}`);
      continue;
    }
    const isHallucinated = item.verdict === 'REFUTED';
    const provenanceUrl = item.metadata?.provenance_url || 'https://fever.ai/resources.html';
    const itemId = item.metadata?.item_id || item.id;
    
    items.push({
      prompt_text: item.claim,
      expected_hallucination: isHallucinated,
      expected_decision: isHallucinated ? 'veto' : 'pass',
      category: 'factual',
      difficulty: 'med',
      notes: `Dataset: FEVER | ID: ${itemId} | URL: ${provenanceUrl}`,
      source: 'external-fever-20260606'
    });
  }
  return items;
}

// Parse HaluEval artifact (markdown format)
function parseHaluEval(content: string): any[] {
  const items: any[] = [];
  const cases = content.split(/## Case /);
  
  for (let i = 1; i < cases.length; i++) {
    const caseText = cases[i]!;
    const caseNum = caseText.match(/^(\d+)/)?.[1];
    if (!caseNum) continue;
    
    const haluId = `HaluEval-${caseNum.padStart(3, '0')}`;
    const provenance = caseText.match(/\*\*Provenance:\*\*\s*(.*)/)?.[1]?.trim();
    const labelMatch = caseText.match(/\*\*Ground-Truth Label:\*\*\s*(HALLUCINATED|FAITHFUL)/)?.[1]?.trim();
    
    // Extract prompt context and response from fenced code blocks
    const codeBlocks = [...caseText.matchAll(/```[\s\S]*?\n([\s\S]*?)\n```/g)];
    const promptBlock = codeBlocks[0]?.[1]?.trim();
    const answerBlock = codeBlocks[1]?.[1]?.trim();
    
    if (!provenance || !labelMatch || !promptBlock || !answerBlock) {
      console.warn(`[HaluEval] Skipping case ${haluId} due to missing fields`);
      continue;
    }
    
    const idMatch = provenance.match(/ID:\s*(\S+)/)?.[1];
    const urlMatch = provenance.match(/URL:\s*(\S+)/)?.[1];
    const url = urlMatch || 'https://github.com/RUCAIBox/HaluEval';
    const itemId = idMatch || `case_${caseNum}`;
    
    const isHallucinated = labelMatch === 'HALLUCINATED';
    
    // Format combined context/prompt based on type of context
    let promptText = '';
    if (caseText.includes('Dialogue context')) {
      promptText = `Context:\n${promptBlock}\n\nResponse:\n${answerBlock}`;
    } else if (caseText.includes('Source document')) {
      promptText = `Document:\n${promptBlock}\n\nSummary:\n${answerBlock}`;
    } else {
      promptText = `Knowledge:\n${promptBlock}\n\nAnswer:\n${answerBlock}`;
    }
    
    items.push({
      prompt_text: promptText,
      expected_hallucination: isHallucinated,
      expected_decision: isHallucinated ? 'veto' : 'pass',
      category: 'factual',
      difficulty: 'med',
      notes: `Dataset: HaluEval | ID: ${itemId} | URL: ${url}`,
      source: 'external-halueval-20260606'
    });
  }
  return items;
}

async function main() {
  console.log('Starting external corpus import...');
  
  // 1. Fetch artifacts from Trinity DB
  console.log('Fetching artifacts...');
  const { data: artifacts, error: artError } = await supabase
    .from('trinity_artifacts')
    .select('id, title, content')
    .in('id', [120349, 120350, 120352]);
    
  if (artError || !artifacts) {
    console.error('Failed to fetch artifacts:', artError?.message);
    process.exit(1);
  }
  
  const truthfulQAArt = artifacts.find(a => a.id === 120349);
  const feverArt = artifacts.find(a => a.id === 120350);
  const haluEvalArt = artifacts.find(a => a.id === 120352);
  
  if (!truthfulQAArt || !feverArt || !haluEvalArt) {
    console.error('Not all artifacts found in the query response.');
    process.exit(1);
  }
  
  // 2. Parse datasets
  console.log('Parsing TruthfulQA...');
  const truthfulQAItems = parseTruthfulQA(truthfulQAArt.content || '');
  console.log(`Parsed ${truthfulQAItems.length} TruthfulQA items.`);
  
  console.log('Parsing FEVER...');
  const feverItems = parseFEVER(feverArt.content || '');
  console.log(`Parsed ${feverItems.length} FEVER items.`);
  
  console.log('Parsing HaluEval...');
  const haluEvalItems = parseHaluEval(haluEvalArt.content || '');
  console.log(`Parsed ${haluEvalItems.length} HaluEval items.`);
  
  const allItems = [...truthfulQAItems, ...feverItems, ...haluEvalItems];
  console.log(`Total parsed items: ${allItems.length}`);
  
  // 3. Import to hal_test_cases with duplicate checking
  let inserted = 0;
  let skipped = 0;
  
  for (const item of allItems) {
    const { data: existing, error: existErr } = await supabase
      .from('hal_test_cases')
      .select('id')
      .eq('notes', item.notes)
      .maybeSingle();
      
    if (existErr) {
      console.error(`Error checking existence of ${item.notes}:`, existErr.message);
      continue;
    }
    
    if (existing) {
      skipped++;
      continue;
    }
    
    const { error: insErr } = await supabase
      .from('hal_test_cases')
      .insert(item);
      
    if (insErr) {
      console.error(`Failed to insert item with notes "${item.notes}":`, insErr.message);
    } else {
      inserted++;
    }
  }
  
  console.log(`Import complete! Inserted: ${inserted}, Skipped (already existed): ${skipped}`);
  
  // 4. Verify distribution and counts
  const { data: stats, error: statsErr } = await supabase
    .from('hal_test_cases')
    .select('source, expected_hallucination')
    .in('source', ['external-truthfulqa-20260606', 'external-fever-20260606', 'external-halueval-20260606']);
    
  if (statsErr || !stats) {
    console.error('Failed to verify imported stats:', statsErr?.message);
    process.exit(1);
  }
  
  console.log('\n=== Database Corpus Verification ===');
  const countsBySource: Record<string, { pass: number, veto: number, total: number }> = {};
  for (const row of stats) {
    const src = row.source;
    if (!countsBySource[src]) {
      countsBySource[src] = { pass: 0, veto: 0, total: 0 };
    }
    countsBySource[src].total++;
    if (row.expected_hallucination) {
      countsBySource[src].veto++;
    } else {
      countsBySource[src].pass++;
    }
  }
  
  for (const [src, c] of Object.entries(countsBySource)) {
    console.log(`Source: ${src}`);
    console.log(`  Total items: ${c.total} (Veto: ${c.veto}, Pass: ${c.pass})`);
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Unhandled import error:', e);
  process.exit(2);
});
