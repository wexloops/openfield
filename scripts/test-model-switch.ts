/**
 * Unload on model switch, no GPU or engine needed: `npm run test:model-switch`.
 *
 * Uses the exported workflows/*.json (the graphs the builders write) to check
 * which app sequences make server/modelSwitch.ts unload ComfyUI's models.
 */
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';

// A fake ComfyUI with --highvram: `queue` is what /queue answers on each poll in
// turn (the last one repeats), and every request lands in `log`.
const log: string[] = [];
let queue: [string[], string[]][] = [[[], []]];
const server = createServer((req, res) => {
  log.push(`${req.method} ${req.url}`);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/system_stats') return res.end(JSON.stringify({ system: { argv: ['main.py', '--highvram'] } }));
  if (req.url === '/queue') {
    const [running, pending] = queue.length > 1 ? queue.shift()! : queue[0];
    return res.end(JSON.stringify({ queue_running: running.map((id, i) => [i, id]), queue_pending: pending.map((id, i) => [i + 1, id]) }));
  }
  res.end('{}');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
process.env.COMFY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// config.ts reads COMFY_URL at import, so the modules load after it is set.
const { ROOT } = await import('../server/config.js');
const { heavyModels, modelsUnloaded, needsUnload, unloadOnModelSwitch } = await import('../server/modelSwitch.js');

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

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

const graph = (file: string) => JSON.parse(readFileSync(join(ROOT, 'workflows', `${file}.json`), 'utf8')) as Record<string, unknown>;
const fast = { pollMs: 5, settleMs: 0 };
/** Submit `file` after `before`, the way engine.submit does; returns the requests from the switch on. */
async function switchTo(before: string, file: string): Promise<string[]> {
  modelsUnloaded();
  await unloadOnModelSwitch(graph(before), fast); // nothing loaded: never unloads, remembers its models
  log.length = 0;
  const queued = await unloadOnModelSwitch(graph(file), fast);
  log.push('submit');
  queued?.();
  await new Promise((r) => setTimeout(r, 100));
  return log.filter((l) => l !== 'GET /system_stats');
}

console.log('\nAgainst a fake ComfyUI (--highvram)');

await checkAsync('switch with an empty queue: models are freed before the graph is submitted', async () => {
  queue = [[[], []]];
  assert.deepEqual(await switchTo('video-t2v', 'image-qwen'), ['GET /queue', 'POST /free', 'submit']);
});

await checkAsync('switch with jobs ahead: submitted at once, freed only once the last job ahead runs', async () => {
  // Two jobs ahead (a running, b waiting); a is done by the fourth poll.
  queue = [[['a'], ['b']], [['a'], ['b']], [['a'], ['b']], [['a'], ['b']], [['b'], []]];
  assert.deepEqual(await switchTo('video-t2v', 'image-qwen'), ['GET /queue', 'submit', 'GET /queue', 'GET /queue', 'GET /queue', 'GET /queue', 'POST /free']);
});

await checkAsync('the same model family never frees, queue or not', async () => {
  queue = [[['a'], []]];
  assert.deepEqual(await switchTo('video-t2v', 'extend-forward'), ['submit']);
});

server.close();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
