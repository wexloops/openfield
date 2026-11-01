/**
 * Video decode option, no GPU or engine needed: `npm run test:video-decode`.
 *
 * Checks src/videoDecode.ts (parsing, the GPU default) and chunkVideoDecodes
 * in server/videoDecode.ts against every workflow in workflows/, which are the
 * graphs the builders write: each whole-clip VAEDecodeTiled turns into chunks,
 * decodes in chunks of their own (Stage, HDR, Cast) stay, and nothing else in
 * a graph changes.
 */
import assert from 'assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../server/config.js';
import { chunkVideoDecodes } from '../server/videoDecode.js';
import { DECODE_CHUNK_FRAMES, DECODE_CHUNK_OVERLAP, gpuVideoDecode, parseVideoDecode } from '../src/videoDecode.js';

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

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const DIR = join(ROOT, 'workflows');
const workflows = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, graph: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Graph }));
/** temporal_size of a whole-clip decode, as the builders write it (ComfyUI's maximum). */
const WHOLE_CLIP = 4096;
const decodes = (g: Graph) => Object.values(g).filter((n) => n.class_type === 'VAEDecodeTiled');

console.log('\nsrc/videoDecode.ts');

check('AMD GPUs default to chunks, everything else to the whole clip', () => {
  assert.equal(gpuVideoDecode('AMD Radeon(TM) 8065S Graphics : native'), 'chunked');
  assert.equal(gpuVideoDecode('Radeon RX 7900 XTX'), 'chunked');
  assert.equal(gpuVideoDecode('NVIDIA GeForce RTX 4090'), 'whole');
  assert.equal(gpuVideoDecode('NVIDIA RTX PRO 6000 Blackwell'), 'whole');
  assert.equal(gpuVideoDecode(undefined), 'whole');
  assert.equal(gpuVideoDecode(''), 'whole');
});

check('the env value is parsed case- and space-tolerant, anything else is unset', () => {
  assert.equal(parseVideoDecode(' Chunked '), 'chunked');
  assert.equal(parseVideoDecode('WHOLE'), 'whole');
  assert.equal(parseVideoDecode('chunks'), undefined);
  assert.equal(parseVideoDecode(''), undefined);
  assert.equal(parseVideoDecode(undefined), undefined);
});

console.log(`\nchunkVideoDecodes over the ${workflows.length} exported workflows`);

check('the builders write whole-clip decodes (the exported workflows are unchanged)', () => {
  const whole = workflows.filter((w) => decodes(w.graph).some((n) => n.inputs.temporal_size === WHOLE_CLIP));
  assert.ok(whole.length >= 20, `only ${whole.length} workflows decode the whole clip`);
});

check('every whole-clip decode turns into chunks, and nothing else changes', () => {
  let changed = 0;
  for (const w of workflows) {
    const before = JSON.parse(JSON.stringify(w.graph)) as Graph;
    const g = JSON.parse(JSON.stringify(w.graph)) as Graph;
    const n = chunkVideoDecodes(g);
    changed += n;
    for (const [id, node] of Object.entries(before)) {
      const wasWhole = node.class_type === 'VAEDecodeTiled' && node.inputs.temporal_size === WHOLE_CLIP;
      const want = wasWhole ? { ...node.inputs, temporal_size: DECODE_CHUNK_FRAMES, temporal_overlap: DECODE_CHUNK_OVERLAP } : node.inputs;
      assert.deepEqual(g[id], { ...node, inputs: want }, `${w.file}: ${id}`);
    }
    assert.deepEqual(Object.keys(g), Object.keys(before), `${w.file}: node ids`);
    assert.equal(n, decodes(before).filter((x) => x.inputs.temporal_size === WHOLE_CLIP).length, `${w.file}: count`);
  }
  assert.ok(changed > 0);
});

check('decodes that run in chunks of their own (Stage, HDR, Cast) stay as they are', () => {
  for (const file of ['stage-shot.json', 'finish-hdr.json', 'cast-video.json']) {
    const w = workflows.find((x) => x.file === file)!;
    const g = JSON.parse(JSON.stringify(w.graph)) as Graph;
    assert.equal(chunkVideoDecodes(g), 0, file);
    assert.deepEqual(g, w.graph, file);
  }
});

check('a second pass changes nothing', () => {
  const g = JSON.parse(JSON.stringify(workflows.find((x) => x.file === 'video-t2v.json')!.graph)) as Graph;
  assert.equal(chunkVideoDecodes(g), 1);
  assert.equal(chunkVideoDecodes(g), 0);
});

check('the chunk values are valid VAEDecodeTiled inputs (min 8 / 4, step 4, overlap under half)', () => {
  assert.ok(DECODE_CHUNK_FRAMES >= 8 && DECODE_CHUNK_FRAMES % 4 === 0);
  assert.ok(DECODE_CHUNK_OVERLAP >= 4 && DECODE_CHUNK_OVERLAP % 4 === 0);
  assert.ok(DECODE_CHUNK_OVERLAP * 2 <= DECODE_CHUNK_FRAMES);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
