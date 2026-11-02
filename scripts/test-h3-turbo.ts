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
import { estimate, type EstimateTake } from '../server/estimate.js';

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
  assert.match(turboProblem('fasth3-6', false, new Set([V11]))!, /does not download this one/, 'no bundle has the FastH3 file');
});

check('the estimate keeps H3 turbo and full sampling apart, and LTX-2.5 as it was', () => {
  const take = (settings: Record<string, unknown>, render_seconds: number): EstimateTake =>
    ({ kind: 'video', status: 'done', render_seconds, settings: JSON.stringify({ width: 896, height: 512, seconds: 5, ...settings }) });
  const list = [
    take({ videoModel: 'h3' }, 1116), take({ videoModel: 'h3' }, 1100),
    take({ videoModel: 'h3', h3Turbo: 'v11-4' }, 247), take({ videoModel: 'h3', h3Turbo: 'v11-4' }, 250),
    take({ videoModel: 'ltx25' }, 90),
  ];
  const q = { kind: 'video', model: 'h3', w: '896', h: '512', seconds: '5' };
  assert.deepEqual(estimate({ ...q, turbo: 'v11-4' }, list), { seconds: 250, samples: 2 });
  assert.deepEqual(estimate({ ...q, turbo: 'none' }, list), { seconds: 1116, samples: 2 });
  assert.deepEqual(estimate({ ...q, turbo: 'v10-8' }, list), { seconds: null, samples: 0 });
  assert.deepEqual(estimate({ ...q, model: 'ltx25' }, list), { seconds: 90, samples: 1 });
});

check('a turbo graph loads its LoRA and runs its steps', () => {
  const g = buildH3Graph({ prompt: 'p', width: 832, height: 480, lengthFrames: 124, seed: 1, steps: 20, startImage: 's.png', turbo: 'v11-4' }) as Record<string, { inputs: Record<string, unknown> }>;
  const json = JSON.stringify(g);
  assert.ok(json.includes(V11));
  assert.equal(g.sched.inputs.steps, 4);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
if (failed) process.exit(1);
