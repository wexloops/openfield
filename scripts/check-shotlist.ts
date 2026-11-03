/**
 * Pins the shot list parser (server/shotlist.ts): what an LLM reply turns into,
 * including replies that are still being written or broke off. No I/O.
 *
 *   npm run shotlist:check
 */
import assert from 'node:assert/strict';
import { parseShotList, partialShots } from '../server/shotlist.js';

const SHOTS = [
  { framing: 'wide', move: 'crane-up', action: 'A keeper climbs the tower stairs in the storm.', seconds: 4 },
  { framing: 'medium', move: 'handheld', action: 'He drags himself up the wet iron steps.', seconds: 3 },
  { framing: 'close', move: 'push-in', action: 'He strikes a match and lights the lamp.', seconds: 3 },
];
const LIST = JSON.stringify({ shots: SHOTS });
let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log(`ok  ${name}`); };

check('a complete reply parses into its shots', () => {
  assert.deepEqual(parseShotList(LIST)?.map((s) => s.action), SHOTS.map((s) => s.action));
});

check('code fences and a bare array parse too', () => {
  assert.equal(parseShotList('```json\n' + JSON.stringify(SHOTS) + '\n```')?.length, 3);
});

check('Gemma slips are repaired ("framing:"wide", "seconds":"4", trailing comma)', () => {
  const slip = '{"shots":[{"framing:"wide","move":"static","action":"A","seconds":"4"},{"framing":"close","move":"static","action":"B","seconds":3},]}';
  const shots = parseShotList(slip);
  assert.equal(shots?.length, 2);
  assert.equal(shots?.[0].framing, 'wide');
  assert.equal(shots?.[0].seconds, 4);
});

check('partialShots counts only shots whose closing brace has arrived', () => {
  const cut = LIST.slice(0, LIST.indexOf('}', LIST.indexOf('}') + 1) + 1); // up to the end of shot 2
  assert.equal(partialShots(cut).length, 2);
  assert.equal(partialShots(cut + ',{"framing":"clo').length, 2);
  assert.equal(partialShots('{"shots":[{"framing":"wide","act').length, 0);
});

check('partialShots respects max', () => {
  assert.equal(partialShots(LIST, 2).length, 2);
});

check('a reply that broke off after two shots still parses into those two', () => {
  const cut = LIST.slice(0, LIST.indexOf('}', LIST.indexOf('}') + 1) + 1) + ',{"framing":"close","mo';
  assert.deepEqual(parseShotList(cut)?.map((s) => s.action), SHOTS.slice(0, 2).map((s) => s.action));
});

check('one shot is not a list', () => {
  assert.equal(parseShotList(JSON.stringify({ shots: SHOTS.slice(0, 1) })), null);
});

console.log(`\n${n} shot list checks passed`);
