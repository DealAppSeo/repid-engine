import * as dotenv from 'dotenv';
dotenv.config();
import { getTwoBuilderSnapshot } from './src/services/two-builder-demo';

async function run() {
  try {
    const res = await getTwoBuilderSnapshot();
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error(e);
  }
}
run();
