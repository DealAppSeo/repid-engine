/**
 * Fixture arena. Two agents. nonprofit-help adds 1. A self-rate of 0 adds nothing.
 * This script does not open a database, a chain, or a network connection.
 */
const START = 1000;
const agents = ['agent-a', 'agent-b'];
const scores = { 'agent-a': START, 'agent-b': START };
const events = [
  { kind: 'nonprofit-help', rater_id: 'agent-b', subject_id: 'agent-a', delta: 1 },
  { kind: 'self-rate', rater_id: 'agent-a', subject_id: 'agent-a', delta: 0 },
];

let nonprofitHelpDelta = 0;
let selfRateDelta = 0;
for (const event of events) {
  if (event.rater_id === event.subject_id) {
    if (event.delta === 0) selfRateDelta = 0;
    continue;
  }
  if (event.kind === 'nonprofit-help' && event.delta === 1) {
    scores[event.subject_id] += 1;
    nonprofitHelpDelta = 1;
  }
}

const winner = scores['agent-a'] > scores['agent-b'] ? 'agent-a' : 'agent-b';

process.stdout.write(
  `agents\t${agents.length}\n` +
    `winner\t${winner}\n` +
    `nonprofit_help_delta\t${nonprofitHelpDelta}\n` +
    `self_rate_delta\t${selfRateDelta}\n`,
);
