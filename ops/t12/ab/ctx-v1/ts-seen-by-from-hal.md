Additional context, read from DealAppSeo/trustshell at commit 9021faff07658ceada5f972a11be7d8391699b42:

The exports you will test, as declared in src/lib/local-only.ts:
```ts
export function seenByFromHal(data: unknown): SeenBy
```

How tests run in this repository:
- Jest with the ts-jest preset. Test files live under tests/ and end in .test.ts.
- ts-jest compiles each test with TypeScript strict mode, so a type error in the test fails it.
- Import only the module under test, with the relative path the task gives. describe, it and expect are Jest globals and need no import.

Lessons from earlier attempts at tasks like this one:
- Read the source before writing an expected value. An assertion that does not match what the code returns makes the test fail.
- Keep every expected value a literal written in the test.
- Reply with one JSON object whose "files" array holds exactly the one test file the task names.
