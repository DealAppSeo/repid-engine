import 'dotenv/config';
import { classify } from '../src/hal/classifier';

(async () => {
  const r = await classify('Who painted The Persistence of Memory?');
  console.log(JSON.stringify(r, null, 2));
  await new Promise(r => setTimeout(r, 800));
})().catch(e => { console.error(e); process.exit(1); });
