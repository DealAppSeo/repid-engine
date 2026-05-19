const fs = require('fs');
const path = require('path');

const dbMigrationsData = JSON.parse(fs.readFileSync('C:\\Users\\Cash4\\.gemini\\antigravity\\brain\\164bddb3-c45d-4147-99d2-960099293410\\.system_generated\\steps\\368\\output.txt', 'utf8').match(/<untrusted-data-[^>]+>\\n([\s\S]*)\\n<\/untrusted-data-/)[1]);

const dbMigrations = dbMigrationsData.map(m => (m.name || m.version.toString()).toLowerCase().replace(/[^a-z0-9]/g, ''));

function normalize(str) {
    return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const localFolders = [
    'C:\\Users\\Cash4\\repos\\repid-engine-gemini\\migrations',
    'C:\\Users\\Cash4\\repos\\repid-engine-gemini\\supabase\\migrations'
];

const unappliedLocal = [];
const localFilesNormalized = new Set();

for (const folder of localFolders) {
    if (!fs.existsSync(folder)) continue;
    for (const file of fs.readdirSync(folder)) {
        if (!file.endsWith('.sql')) continue;
        
        // Exclude the known 2.11 files
        if (file === '20260517_phase2_11_reputation_attestations.sql' || file === '20260517_phase2_11_storage_contracts.sql') {
            continue;
        }

        const normalizedName = normalize(file.replace('.sql', ''));
        localFilesNormalized.add(normalizedName);
        
        let found = false;
        for (const dbm of dbMigrations) {
            // fuzzy match
            if (normalizedName.includes(dbm) || dbm.includes(normalizedName)) {
                found = true;
                break;
            }
        }
        
        if (!found) {
            const filePath = path.join(folder, file);
            const stats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8').split('\n').slice(0,3).join('\\n');
            unappliedLocal.push({
                file,
                folder,
                created: stats.mtime.toISOString(),
                snippet: content
            });
        }
    }
}

console.log("=== DB-A Unapplied ===");
for (const u of unappliedLocal) {
    console.log(`- Path: ${path.join(u.folder, u.file)}`);
    console.log(`  Date: ${u.created}`);
    console.log(`  Snippet: ${u.snippet.substring(0, 150)}`);
}

console.log("\n=== DB-B Not in Repo ===");
for (const dbm of dbMigrationsData) {
    if (dbm.version === '20260517081724') continue; // exclude CC's 2.10
    
    // check if it is within 60 days. Just check starting with '202604' or '202605'
    if (!dbm.version.startsWith('202605') && !dbm.version.startsWith('202604')) continue;
    
    const dbmNormalized = normalize(dbm.name || dbm.version.toString());
    let found = false;
    for (const lname of localFilesNormalized) {
        if (lname.includes(dbmNormalized) || dbmNormalized.includes(lname)) {
            found = true;
            break;
        }
    }
    if (!found) {
        console.log(`- DB Version: ${dbm.version} Name: ${dbm.name}`);
    }
}
