/**
 * LTX-2.5 weight overrides, no GPU or engine needed: `npm run test:ltxfiles`.
 *
 * Checks server/graphs/ltxfiles.ts and everything that reads it:
 *   - the four names fall back to the stock files, and take OPENFIELD_LTX25_*;
 *   - no graph builder keeps a copy of a stock name;
 *   - every workflow `npm run workflows` exports builds exactly the committed
 *     workflows/*.json without overrides, and with overrides loads the
 *     configured files and no stock one;
 *   - activeBundles() and preflight check for the configured files, keep the
 *     stock ones without overrides, and never offer a configured file for download.
 */
import assert from 'assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../server/config.js';
import { LTX25_ENV, LTX25_STOCK, clearLtx25Overrides, ltx25Files, ltx25Overrides, type Ltx25Slot } from '../server/graphs/ltxfiles.js';
import { buildLtx25Graph } from '../server/graphs/ltx25.js';
import { BUNDLES, activeBundles, type Bundle } from '../server/models.js';
import { reasonFor, statusFor } from '../server/preflight.js';
import { ENTRIES, OUT } from './export-workflows.js';

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

const SLOTS = Object.keys(LTX25_STOCK) as Ltx25Slot[];
const STOCK_NAMES = SLOTS.map((s) => LTX25_STOCK[s]);
// Names as ComfyUI on Windows lists files in a subfolder.
const CUSTOM: Record<Ltx25Slot, string> = {
  transformer: 'ltx25\\custom-transformer-fp8.safetensors',
  textEncoder: 'ltx25\\custom-gemma-int8.safetensors',
  videoVae: 'ltx25\\custom-video-vae.safetensors',
  audioVae: 'ltx25\\custom-audio-vae.safetensors',
};
const setOverrides = () => { for (const s of SLOTS) process.env[LTX25_ENV[s]] = CUSTOM[s]; };

// This machine's .env may set overrides; every check starts from none.
clearLtx25Overrides();

// ------------------------------------------------------------ module ----
console.log('\nltxfiles.ts');

check('without overrides every slot is the stock file', () => {
  assert.deepEqual(ltx25Files(), LTX25_STOCK);
  assert.deepEqual(ltx25Overrides(), {});
});

check('each variable overrides its own slot only, trimmed', () => {
  const env = { [LTX25_ENV.videoVae]: '  ltx25\\v.safetensors \n' };
  assert.deepEqual(ltx25Files(env), { ...LTX25_STOCK, videoVae: 'ltx25\\v.safetensors' });
  assert.deepEqual(ltx25Overrides(env), { videoVae: 'ltx25\\v.safetensors' });
});

check('an empty or blank variable keeps the stock file', () => {
  assert.deepEqual(ltx25Files({ [LTX25_ENV.transformer]: '', [LTX25_ENV.audioVae]: '   ' }), LTX25_STOCK);
});

check('clearLtx25Overrides removes all four variables', () => {
  const env: NodeJS.ProcessEnv = { OTHER: 'x' };
  for (const s of SLOTS) env[LTX25_ENV[s]] = CUSTOM[s];
  clearLtx25Overrides(env);
  assert.deepEqual(env, { OTHER: 'x' });
});

check('no source file outside ltxfiles.ts spells out a stock name', () => {
  const dirs = ['server/graphs', 'server'];
  const hits: string[] = [];
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.ts') && x !== 'ltxfiles.ts')) {
      const text = readFileSync(join(ROOT, d, f), 'utf8');
      for (const n of STOCK_NAMES) if (text.includes(n)) hits.push(`${d}/${f}: ${n}`);
    }
  }
  assert.deepEqual(hits, []);
});

// ------------------------------------------------------- graph builders ----
console.log('\nGraph builders (every workflow that `npm run workflows` exports)');

const built = (e: (typeof ENTRIES)[number]) => JSON.stringify(e.build(), null, 2) + '\n';
const committed = (file: string) => readFileSync(join(OUT, `${file}.json`), 'utf8').replace(/\r\n/g, '\n');
const stock = new Map(ENTRIES.map((e) => [e.file, built(e)]));
const usesLtx25 = ENTRIES.filter((e) => STOCK_NAMES.some((n) => stock.get(e.file)!.includes(JSON.stringify(n))));

check('without overrides each graph equals the committed workflows/*.json', () => {
  const differ = ENTRIES.filter((e) => stock.get(e.file) !== committed(e.file)).map((e) => e.file);
  assert.deepEqual(differ, []);
});

check('the LTX-2.5 apps are covered (more than 30 workflows load the stock files)', () => {
  assert.ok(usesLtx25.length > 30, `only ${usesLtx25.length}`);
});

setOverrides();
try {
  check('with overrides no graph loads a stock file', () => {
    const left = ENTRIES.flatMap((e) => STOCK_NAMES.filter((n) => built(e).includes(JSON.stringify(n))).map((n) => `${e.file}: ${n}`));
    assert.deepEqual(left, []);
  });

  check('with overrides each stock file input holds its configured file, and nothing else changes', () => {
    type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const slotOf = new Map(SLOTS.map((s) => [LTX25_STOCK[s], s]));
    for (const e of usesLtx25) {
      const before = JSON.parse(stock.get(e.file)!) as Graph;
      const after = e.build() as Graph;
      assert.deepEqual(Object.keys(after), Object.keys(before), `${e.file}: node ids`);
      for (const [id, node] of Object.entries(before)) {
        for (const [k, v] of Object.entries(node.inputs)) {
          const slot = typeof v === 'string' ? slotOf.get(v) : undefined;
          const want = slot ? CUSTOM[slot] : v;
          assert.deepEqual(after[id].inputs[k], want, `${e.file}: ${id}.${k} (${node.class_type})`);
        }
      }
    }
  });

  check('with overrides the graphs that do not use LTX-2.5 stay the same', () => {
    const changed = ENTRIES.filter((e) => !usesLtx25.includes(e) && built(e) !== stock.get(e.file)).map((e) => e.file);
    assert.deepEqual(changed, []);
  });

  check('a checkpoint picked for one render still wins over the transformer override', () => {
    const g = buildLtx25Graph({ prompt: 'p', width: 768, height: 512, seconds: 2, seed: 1, transformer: 'picked.safetensors' }) as Record<string, { inputs: Record<string, unknown> }>;
    assert.equal(g.unet.inputs.unet_name, 'picked.safetensors');
    assert.equal(g.clip.inputs.clip_name, CUSTOM.textEncoder);
  });
} finally {
  clearLtx25Overrides();
}

// ------------------------------------------------------ model check ----
console.log('\nModel manifest and preflight');

const ltx = (bs: Bundle[]) => bs.find((b) => b.id === 'ltx25')!;
// What preflight sees: each loader's list as ComfyUI returns it.
const listing = (names: string[]) => ({
  diffusion_models: new Set(names), text_encoders: new Set(names), vae: new Set(names), latent_upscale_models: new Set(names),
});
const UPSCALER = ltx(BUNDLES).files.find((f) => f.dir === 'latent_upscale_models')!.file;

check('without overrides activeBundles() is the manifest itself', () => {
  assert.equal(activeBundles({}), BUNDLES);
});

check('BUNDLES (and so docs/MODELS.md) keeps the stock files', () => {
  const files = ltx(BUNDLES).files.map((f) => f.file);
  for (const n of STOCK_NAMES) assert.ok(files.includes(n), n);
});

const env: NodeJS.ProcessEnv = {};
for (const s of SLOTS) env[LTX25_ENV[s]] = CUSTOM[s];
const active = activeBundles(env);

check('with overrides the ltx25 bundle lists the configured files, marked, and keeps the upscaler', () => {
  const files = ltx(active).files;
  for (const s of SLOTS) {
    const f = files.find((x) => x.file === CUSTOM[s]);
    assert.ok(f, `${s} missing`);
    assert.equal(f!.override, LTX25_ENV[s]);
    assert.equal(f!.gb, 0, `${s}: nothing to download, so no size`);
  }
  const up = files.find((f) => f.file === UPSCALER)!;
  assert.equal(up.override, undefined);
  assert.equal(files.length, ltx(BUNDLES).files.length);
});

check('with overrides every other bundle is unchanged', () => {
  for (const b of active) if (b.id !== 'ltx25') assert.equal(b, BUNDLES.find((x) => x.id === b.id));
});

check('one override replaces one file only', () => {
  const files = ltx(activeBundles({ [LTX25_ENV.audioVae]: CUSTOM.audioVae })).files;
  assert.deepEqual(files.filter((f) => f.override).map((f) => f.file), [CUSTOM.audioVae]);
  assert.ok(files.some((f) => f.file === LTX25_STOCK.transformer));
});

check('preflight: the stock files under their own names make the stock bundle ready', () => {
  const st = statusFor(ltx(BUNDLES), listing([...STOCK_NAMES, UPSCALER]), new Set());
  assert.equal(st.ready, true, st.missingFiles.map((f) => f.file).join());
});

check('preflight: a stock file in a subfolder is missing (ComfyUI would refuse the bare name)', () => {
  const st = statusFor(ltx(BUNDLES), listing([...STOCK_NAMES.slice(1), `sub\\${STOCK_NAMES[0]}`, UPSCALER]), new Set());
  assert.deepEqual(st.missingFiles.map((f) => f.file), [STOCK_NAMES[0]]);
});

check('preflight: a configured name without its subfolder does not match the file in it', () => {
  const bare = 'custom-transformer-fp8.safetensors';
  const st = statusFor(ltx(activeBundles({ [LTX25_ENV.transformer]: bare })), listing([...STOCK_NAMES.slice(1), CUSTOM.transformer, UPSCALER]), new Set());
  assert.deepEqual(st.missingFiles.map((f) => f.file), [bare]);
});

check('preflight: configured files listed by ComfyUI make the overridden bundle ready', () => {
  const st = statusFor(ltx(active), listing([...Object.values(CUSTOM), UPSCALER]), new Set());
  assert.equal(st.ready, true, st.missingFiles.map((f) => f.file).join());
});

check('preflight: with overrides the stock files alone are not enough', () => {
  const st = statusFor(ltx(active), listing([...STOCK_NAMES, UPSCALER]), new Set());
  assert.deepEqual(st.missingFiles.map((f) => f.file).sort(), Object.values(CUSTOM).sort());
});

check('preflight: a configured name must match the listed subfolder', () => {
  const st = statusFor(ltx(active), listing([...Object.values(CUSTOM).map((n) => n.replace('ltx25\\', 'other\\')), UPSCALER]), new Set());
  assert.equal(st.missingFiles.length, 4);
});

check('the message for a missing configured file names its variable and no download', () => {
  const st = statusFor(ltx(active), listing([...Object.values(CUSTOM).slice(1), UPSCALER]), new Set());
  const msg = reasonFor([st], ['ltx25'])!;
  assert.match(msg, /custom-transformer-fp8\.safetensors \(models\/diffusion_models\/, set by OPENFIELD_LTX25_TRANSFORMER\)/);
  assert.doesNotMatch(msg, /npm run models/);
  assert.match(msg, /match the name ComfyUI lists/);
});

check('the message for a missing stock file still points at npm run models', () => {
  const st = statusFor(ltx(BUNDLES), listing([UPSCALER]), new Set());
  const msg = reasonFor([st], ['ltx25'])!;
  assert.match(msg, /npm run models/);
  assert.doesNotMatch(msg, /set by/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
