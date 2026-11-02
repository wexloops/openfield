/**
 * Unload on model switch, no GPU or engine needed: `npm run test:model-switch`.
 *
 * Uses the exported workflows/*.json (the graphs the builders write) to check
 * which app sequences make server/modelSwitch.ts unload ComfyUI's models.
 */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../server/config.js';
import { heavyModels, needsUnload } from '../server/modelSwitch.js';

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const models = (file: string) => heavyModels(JSON.parse(readFileSync(join(ROOT, 'workflows', `${file}.json`), 'utf8')));
/** Run apps in order from an unknown start; return after which steps an unload happens. */
function unloadsIn(...files: string[]): string[] {
  let loaded: Set<string> | null = null;
  const at: string[] = [];
  for (const f of files) {
    const next = models(f);
    if (needsUnload(loaded, next)) {
      at.push(f);
      loaded = new Set(next);
    } else {
      loaded = new Set([...(loaded ?? []), ...next]);
    }
  }
  return at;
}

console.log('\nserver/modelSwitch.ts');

check('a video graph loads the LTX-2.5 transformer and Gemma, nothing small', () => {
  const m = models('video-t2v');
  assert.deepEqual([...m].sort(), ['gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors']);
});

check('LTX-2.5 apps one after another never unload (video, extend, effect, HDR, add sound)', () => {
  assert.deepEqual(unloadsIn('video-t2v', 'extend-forward', 'effect-flood', 'finish-hdr', 'add-sound', 'video-i2v'), []);
});

check('video, then a Qwen-Image still, then Qwen-Image-Edit: unloads before each new model family', () => {
  assert.deepEqual(unloadsIn('video-t2v', 'image-qwen', 'edit-free'), ['image-qwen', 'edit-free']);
});

check('Qwen-Image draft and full quality share the model: no unload between them', () => {
  assert.deepEqual(unloadsIn('image-qwen', 'image-qwen-draft'), []);
});

check('back to video after the stills unloads again', () => {
  assert.deepEqual(unloadsIn('video-t2v', 'image-qwen', 'video-i2v'), ['image-qwen', 'video-i2v']);
});

check('the first graph after a start, or after a manual free, never unloads', () => {
  assert.equal(needsUnload(null, models('image-qwen')), false);
  assert.equal(needsUnload(new Set(), models('image-qwen')), false);
});

check('a graph without large models (cutout still) never unloads', () => {
  assert.equal(models('cutout-still').size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
