/**
 * Model slots across all families, no GPU or engine needed: `npm run test:model-slots`.
 * Each family has its own test as well: `npm run test:slots-<family>`
 * (scripts/test-slot-family.ts).
 *
 * Checks server/graphs/slots.ts and everything that reads it:
 *   - slot ids, variables and stock files are unique, and every family has
 *     slots and its own test script;
 *   - a variable that names the stock file changes nothing;
 *   - no graph builder keeps a copy of a stock name;
 *   - every workflow `npm run workflows` exports builds exactly the committed
 *     workflows/*.json without variables;
 *   - docs/MODELS.md is the same whatever .env sets;
 *   - `npm run models` fetches the stock files without variables, and with
 *     every slot set no configured file and no stock file a slot replaces;
 *   - a failed render names only the configured files it depends on.
 */
import assert from 'assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../server/config.js';
import { MODEL_SLOTS, SLOT_FAMILIES, clearSlotOverrides, configuredSlots, resolveSlot, slotFailureNote, slotFile, withSlotNote, type SlotId } from '../server/graphs/slots.js';
import { buildLtx25Graph } from '../server/graphs/ltx25.js';
import { EDIT_LIGHTNING_2509, editLightning } from '../server/graphs/edit.js';
import { BUNDLES, activeBundles } from '../server/models.js';
import { reasonFor, statusFor } from '../server/preflight.js';
import { isUserLora } from '../server/loras.js';
import { CUSTOM, ENTRIES, STOCK_NAMES, built, byId, check, committed, envFor, fetched, listing, loads, report, stock, withEnv, type Graph } from './slot-checks.js';

// This machine's .env may set slots; every check starts from none.
clearSlotOverrides();

console.log('\nAll slots');

check('slot ids, variables and stock files are unique, every slot has a family, every family has slots', () => {
  for (const key of ['id', 'env', 'stock'] as const) {
    const all = MODEL_SLOTS.map((s) => s[key]);
    assert.equal(new Set(all).size, all.length, key);
  }
  for (const s of MODEL_SLOTS) assert.ok(SLOT_FAMILIES.some((f) => f.id === s.family), s.id);
  for (const f of SLOT_FAMILIES) assert.ok(MODEL_SLOTS.some((s) => s.family === f.id), f.id);
});

check('every family has its test:slots-<family> script, and every such script a family', () => {
  const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const f of SLOT_FAMILIES) assert.equal(scripts[`test:slots-${f.id}`], `tsx scripts/test-slot-family.ts ${f.id}`, f.id);
  const extra = Object.keys(scripts).filter((k) => k.startsWith('test:slots-') && !SLOT_FAMILIES.some((f) => k === `test:slots-${f.id}`));
  assert.deepEqual(extra, []);
});

check('an unknown slot id throws', () => {
  assert.throws(() => slotFile('no.such' as SlotId), /unknown model slot/);
});

check('a variable that names the stock file counts as stock everywhere', () => {
  const env = Object.fromEntries(MODEL_SLOTS.map((s) => [s.env, ` ${s.stock} `]));
  for (const s of MODEL_SLOTS) assert.deepEqual(resolveSlot(s.id, env), { file: s.stock, source: 'stock' });
  assert.deepEqual(configuredSlots(env), []);
  assert.equal(activeBundles(env), BUNDLES);
  withEnv(env, () => assert.equal(editLightning(new Set([EDIT_LIGHTNING_2509])), EDIT_LIGHTNING_2509));
});

check('no server source outside slots.ts and the manifest spells out a stock name', () => {
  const skip = new Set(['slots.ts', 'models.ts']);
  const hits: string[] = [];
  for (const d of ['server/graphs', 'server']) {
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.ts') && !skip.has(x))) {
      const text = readFileSync(join(ROOT, d, f), 'utf8');
      for (const n of STOCK_NAMES) if (text.includes(n)) hits.push(`${d}/${f}: ${n}`);
    }
  }
  assert.deepEqual(hits, []);
});

check('clearSlotOverrides removes every slot variable and nothing else', () => {
  const env: NodeJS.ProcessEnv = { OTHER: 'x', ...envFor(MODEL_SLOTS) };
  clearSlotOverrides(env);
  assert.deepEqual(env, { OTHER: 'x' });
});

check('without variables each graph equals the committed workflows/*.json', () => {
  const differ = ENTRIES.filter((e) => stock(e.file) !== committed(e.file)).map((e) => e.file);
  assert.deepEqual(differ, []);
});

check('the LTX-2.5 apps are covered (more than 30 workflows load the stock transformer)', () => {
  assert.ok(ENTRIES.filter((e) => loads(e.file, slotFile('ltx25.transformer'))).length > 30);
});

check('with every slot set the graphs without slot files stay the same', () => {
  const usesSlots = ENTRIES.filter((e) => STOCK_NAMES.some((n) => loads(e.file, n)));
  const changed = withEnv(envFor(MODEL_SLOTS), () => ENTRIES.filter((e) => !usesSlots.includes(e) && built(e) !== stock(e.file)).map((e) => e.file));
  assert.deepEqual(changed, []);
});

const committedDoc = readFileSync(join(ROOT, 'docs', 'MODELS.md'), 'utf8').replace(/\r\n/g, '\n');
// gen-models-doc builds the text when it is imported, so import it with every slot set.
Object.assign(process.env, envFor(MODEL_SLOTS));
const docWithEnv = await import('./gen-models-doc.js').then((m) => m.MODELS_DOC).finally(() => clearSlotOverrides());

check('docs/MODELS.md is the committed one even with every slot set, and lists every slot', () => {
  assert.equal(docWithEnv, committedDoc);
  for (const s of MODEL_SLOTS) {
    assert.ok(committedDoc.includes(`\`${s.env}\``), s.env);
    assert.ok(committedDoc.includes(`\`${s.stock}\``), s.stock);
    assert.ok(!committedDoc.includes(CUSTOM[s.id]), CUSTOM[s.id]);
  }
});

check('BUNDLES keeps the stock files, and without variables activeBundles() is the manifest itself', () => {
  const files = BUNDLES.flatMap((b) => b.files.map((f) => f.file));
  for (const n of STOCK_NAMES) assert.ok(files.includes(n), n);
  assert.equal(activeBundles({}), BUNDLES);
});

check('npm run models: with every slot set it fetches no configured file and no stock file a slot replaces', () => {
  const fetch = new Set(fetched(activeBundles(envFor(MODEL_SLOTS))));
  for (const s of MODEL_SLOTS) {
    assert.ok(!fetch.has(CUSTOM[s.id]), CUSTOM[s.id]);
    assert.ok(!fetch.has(s.stock), s.stock);
  }
  for (const b of activeBundles(envFor(MODEL_SLOTS))) {
    for (const f of b.files.filter((x) => x.slot)) assert.equal(f.gb, 0, `${b.id}: ${f.file}`);
  }
});

check('npm run models: without variables it fetches the stock files of the manifest', () => {
  assert.deepEqual(fetched(activeBundles({})), BUNDLES.flatMap((b) => b.files).map((f) => f.file));
});

check('a checkpoint picked for one render still wins over the transformer slot', () => {
  withEnv(envFor(MODEL_SLOTS), () => {
    const g = buildLtx25Graph({ prompt: 'p', width: 768, height: 512, seconds: 2, seed: 1, transformer: 'picked.safetensors' }) as Graph;
    assert.equal(g.unet.inputs.unet_name, 'picked.safetensors');
    assert.equal(g.clip.inputs.clip_name, CUSTOM['ltx25.textEncoder']);
  });
});

check('edits: the 2509 Lightning LoRA replaces only the stock draft LoRA', () => {
  const have = new Set([EDIT_LIGHTNING_2509]);
  assert.equal(editLightning(have), EDIT_LIGHTNING_2509);
  assert.equal(editLightning(new Set()), slotFile('qwen.lightning'));
  withEnv({ OPENFIELD_QWEN_LIGHTNING_LORA: 'mine.safetensors' }, () => assert.equal(editLightning(have), 'mine.safetensors'));
});

check('a LoRA set for a slot in .env is not offered as your own LoRA', () => {
  const mine = 'sub\\my-ingredients-v2.safetensors';
  assert.equal(isUserLora(mine), true);
  withEnv({ OPENFIELD_LTX25_CAST_LORA: mine }, () => assert.equal(isUserLora(mine), false));
  assert.equal(isUserLora(slotFile('ltx25-loras.cast')), false, 'the stock file stays built in');
});

check('a failed render names only the configured files it loads, not every variable that is set', () => {
  const env = envFor(MODEL_SLOTS);
  const flux2 = ENTRIES.find((e) => loads(e.file, slotFile('flux2.model')))!;
  const g = withEnv(env, () => flux2.build());
  const note = slotFailureNote(g, null, env)!;
  assert.ok(note.includes(CUSTOM['flux2.model']), note);
  assert.ok(!note.includes(CUSTOM['ltx25.transformer']), note);
  assert.equal(slotFailureNote(g, 'no-such-node', env), note, 'a node id the graph does not have: the whole render');
});

check('a failed render\'s error is the engine\'s message, then the slot note when there is one', () => {
  const env = envFor(MODEL_SLOTS);
  const flux2 = ENTRIES.find((e) => loads(e.file, slotFile('flux2.model')))!;
  const g = withEnv(env, () => flux2.build());
  assert.equal(withSlotNote('boom', null, null, env), 'boom', 'no graph: no note');
  assert.equal(withSlotNote('boom', JSON.parse(stock(flux2.file)), null, env), 'boom', 'stock files only: no note');
  assert.equal(withSlotNote('boom', g, null, env), `boom ${slotFailureNote(g, null, env)}`);
});

check('the message for a missing stock file still points at npm run models and names no slot', () => {
  const st = statusFor(byId(BUNDLES, 'ltx25'), listing([]), new Set());
  const msg = reasonFor([st], ['ltx25'])!;
  assert.match(msg, /npm run models/);
  assert.doesNotMatch(msg, /slot "|set by/);
});

report();
