/**
 * H3 turbo presets, no GPU or engine needed: `npm run test:h3-turbo`.
 *
 * The page's list (src/presets.ts) and the server's (server/graphs/h3.ts) must
 * name the same presets and files; the Video page offers only what ComfyUI
 * lists; the server refuses an unknown preset or a missing LoRA in words.
 */
import assert from 'assert/strict';
import { H3_REF_TURBO_FILE, H3_TURBO, H3_TURBO_FILES, availableH3Turbo } from '../src/presets.js';
import { H3_REF_TURBO_LORA, H3_TURBO_PRESETS, buildH3Graph, turboProblem } from '../server/graphs/h3.js';

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const V11 = H3_TURBO_FILES['v11-4'];

check('page and server name the same presets, files and steps', () => {
  assert.deepEqual(H3_TURBO.map((t) => t.key), H3_TURBO_PRESETS.map((p) => p.id));
  for (const p of H3_TURBO_PRESETS) {
    assert.equal(H3_TURBO_FILES[p.id], p.fl2vaLora, p.id);
    assert.equal(H3_TURBO.find((t) => t.key === p.id)?.steps, p.steps, p.id);
  }
  assert.equal(H3_REF_TURBO_FILE, H3_REF_TURBO_LORA);
});

check('the page offers only the presets whose LoRA ComfyUI lists, under that exact name', () => {
  assert.deepEqual(availableH3Turbo([]), []);
  assert.deepEqual(availableH3Turbo(['other.safetensors', V11]).map((t) => t.key), ['v11-4']);
  assert.deepEqual(availableH3Turbo([`sub\\${V11}`]), [], 'a file in a subfolder is another name to ComfyUI');
});

check('the server lets a listed preset run, and refuses a missing LoRA or an unknown id in words', () => {
  assert.equal(turboProblem('v11-4', false, new Set([V11])), null);
  assert.match(turboProblem('v10-8', false, new Set([V11]))!, /needs minimax_h3_fl2v_turbo_8step.*models\/loras.*h3-turbo/);
  assert.match(turboProblem('v11-4', true, new Set([V11]))!, /ref2v/, 'Refs mode needs the ref2v distill');
  assert.match(turboProblem('warp-9', false, new Set([V11]))!, /Unknown H3 turbo preset "warp-9"/);
});

check('a turbo graph loads its LoRA and runs its steps', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20, startImage: 's.png', turbo: 'v11-4' }) as Record<string, { inputs: Record<string, unknown> }>;
  const json = JSON.stringify(g);
  assert.ok(json.includes(V11));
  assert.equal(g.sched.inputs.steps, 4);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
