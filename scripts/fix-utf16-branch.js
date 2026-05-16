const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', '..', 'repid-engine', '.git', 'worktrees', 'repid-engine-gemini', 'EXPECTED_BRANCH');

if (fs.existsSync(targetPath)) {
  const buf = fs.readFileSync(targetPath);
  
  // Check for UTF-16 LE BOM (FF FE)
  let isUtf16Le = buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE;
  
  let content = '';
  if (isUtf16Le) {
    // Strip BOM and decode as UTF-16 LE
    content = buf.subarray(2).toString('utf16le');
  } else {
    // Fallback to utf-8 (stripping any utf-8 BOM if present)
    content = buf.toString('utf8');
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
  }

  // Remove any remaining null bytes and trim whitespace
  const cleaned = content.replace(/\0/g, '').trim();

  // Write as clean UTF-8
  fs.writeFileSync(targetPath, cleaned, { encoding: 'utf8' });
  console.log(`Rewrote EXPECTED_BRANCH in pure UTF-8: ${cleaned}`);
} else {
  console.log('EXPECTED_BRANCH file not found, nothing to do.');
}
