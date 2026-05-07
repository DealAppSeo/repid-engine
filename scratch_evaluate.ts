import { evaluate } from './src/hal/lib/evaluate';
async function main() {
  const res1 = await evaluate('hello', 'world', {} as any);
  const res2 = await evaluate('what is 2+2', '4', {} as any);
  console.log(res1.hal_score, res2.hal_score);
}
main();
