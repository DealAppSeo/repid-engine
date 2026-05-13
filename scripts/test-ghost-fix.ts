import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import ConstitutionalAgentV4 from '../../trinity-symphony-shared/lib/ConstitutionalAgentV4.js';

dotenv.config({ path: '../trinity-symphony-shared/.env' });

async function runTest() {
    console.log("Setting up test...");
    
    // We need SUPABASE_URL and SUPABASE_SERVICE_KEY from process.env, 
    // or just pass them to the agent constructor if needed, 
    // but the agent usually grabs from env.
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://qnnpjhlxljtqyigedwkb.supabase.co';
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    
    if (!key) {
        console.error("Missing Supabase key in env!");
        process.exit(1);
    }
    
    // Initialize an agent
    const agent = new ConstitutionalAgentV4('test-agent-ghost-fix');
    
    const fakeTaskId = 'ghost-fix-test-' + Date.now();
    const fakeContent = '# This is a test artifact\nIt should not be a ghost.';
    
    console.log("Calling saveArtifact...");
    const urlResult = await agent.saveArtifact(fakeTaskId, fakeContent, 'md', 'Ghost Fix Verification Test');
    
    console.log(`saveArtifact returned: ${urlResult}`);
    
    // Verify it in the DB
    const supabase = createClient(url, key);
    
    const { data, error } = await supabase
        .from('trinity_artifacts')
        .select('*')
        .eq('task_id', fakeTaskId)
        .single();
        
    if (error) {
        console.error("Verification failed to fetch artifact:", error);
        process.exit(1);
    }
    
    console.log("Artifact retrieved from DB:");
    console.log(`- filename: ${data.filename}`);
    console.log(`- content_preview: ${data.content_preview ? "PRESENT" : "NULL"}`);
    console.log(`- agent: ${data.agent}`);
    console.log(`- creator_agent: ${data.creator_agent}`);
    
    if (data.filename && data.content_preview && data.agent !== 'system') {
        console.log("✅ Ghost Fix Verification PASS");
    } else {
        console.error("❌ Ghost Fix Verification FAIL");
        process.exit(1);
    }
    
    // Test the CHECK constraint
    console.log("Testing CHECK constraint with a synthesized ghost row...");
    const { error: constraintError } = await supabase
        .from('trinity_artifacts')
        .insert({
            task_id: 'ghost-constraint-test-' + Date.now(),
            agent: 'system',
            artifact_type: 'md',
            content: 'I have content but no legacy preview or location'
            // no filename, no file_path, no external_url, no content_preview
        });
        
    if (constraintError && constraintError.message.includes('trinity_artifacts_has_content_or_location')) {
        console.log("✅ CHECK Constraint PASS (It successfully blocked the ghost)");
    } else {
        console.error("❌ CHECK Constraint FAIL. Ghost was allowed or different error:");
        console.error(constraintError);
        process.exit(1);
    }
}

runTest().catch(console.error);
