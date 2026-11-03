/**
 * The model slots of one family, no GPU or engine needed:
 * `npm run test:slots-<family>`, for example `npm run test:slots-qwen`.
 * The checks for all slots together are in scripts/test-model-slots.ts.
 *
 * With the family's .env variables set:
 *   - each slot takes its own variable and falls back to its stock file;
 *   - every exported workflow loads the configured files, no stock file of the
 *     family, and nothing else changes;
 *   - a failed render names the slot and the file;
 *   - activeBundles() lists the configured files, `npm run models` fetches
 *     neither them nor the stock files they replace, and preflight checks for
 *     them and names slot, file and variable when one is missing.
 */
import assert from 'assert/strict';
import { MODEL_SLOTS, SLOT_FAMILIES, clearSlotOverrides, modelSlot, resolveSlot, slotFailureNote, slotFile, slotOrigin } from '../server/graphs/slots.js';
import { BUNDLES, activeBundles } from '../server/models.js';
import { reasonFor, statusFor } from '../server/preflight.js';
import { CUSTOM, ENTRIES, built, byId, check, envFor, fetched, listing, loads, report, stock, withEnv, type Graph } from './slot-checks.js';

// This machine's .env may set slots; every check starts from none.
clearSlotOverrides();

const id = process.argv[2];
const fam = SLOT_FAMILIES.find((f) => f.id === id);
if (!fam) {
  console.error(`Usage: tsx scripts/test-slot-family.ts <family>, one of: ${SLOT_FAMILIES.map((f) => f.id).join(', ')}`);
  process.exit(2);
}

const slots = MODEL_SLOTS.filter((s) => s.family === fam.id);
const env = envFor(slots);
const others = MODEL_SLOTS.filter((s) => s.family !== fam.id);
const uses = ENTRIES.filter((e) => slots.some((s) => loads(e.file, s.stock)));
const holders = BUNDLES.filter((b) => b.files.some((f) => slots.some((s) => s.stock === f.file))).map((b) => b.id);
const active = activeBundles(env);

console.log(`\n${fam.label} (${fam.id}: ${slots.map((s) => s.id.split('.')[1]).join(', ')})`);

check('without variables every slot is its stock file', () => {
  for (const s of slots) assert.deepEqual(resolveSlot(s.id, {}), { file: s.stock, source: 'stock' });
});

check('each variable sets its own slot only, trimmed; a blank one keeps the stock file', () => {
  for (const s of slots) {
    const one = { [s.env]: `  ${CUSTOM[s.id]} \n` };
    assert.deepEqual(resolveSlot(s.id, one), { file: CUSTOM[s.id], source: 'env' });
    for (const o of MODEL_SLOTS.filter((x) => x !== s)) assert.equal(slotFile(o.id, one), o.stock, `${s.env} moved ${o.id}`);
    assert.equal(slotFile(s.id, { [s.env]: '   ' }), s.stock);
  }
});

check('every stock file is a manifest file in the slot\'s folder', () => {
  for (const s of slots) {
    assert.ok(BUNDLES.some((b) => b.files.some((f) => f.file === s.stock && f.dir === s.dir)), `${s.id}: ${s.stock} in models/${s.dir}/`);
  }
});

check('every slot is loaded by at least one exported workflow', () => {
  assert.deepEqual(slots.filter((s) => !ENTRIES.some((e) => loads(e.file, s.stock))).map((s) => s.id), []);
});

check('with the variables set no graph loads a stock file of the family', () => {
  const left = withEnv(env, () => ENTRIES.flatMap((e) => {
    const text = built(e);
    return slots.filter((s) => text.includes(JSON.stringify(s.stock))).map((s) => `${e.file}: ${s.stock}`);
  }));
  assert.deepEqual(left, []);
});

check('with the variables set each stock input holds its configured file, and nothing else changes', () => {
  const slotOf = new Map(slots.map((s) => [s.stock, s.id]));
  withEnv(env, () => {
    for (const e of ENTRIES) {
      const before = JSON.parse(stock(e.file)) as Graph;
      const after = e.build() as Graph;
      assert.deepEqual(Object.keys(after), Object.keys(before), `${e.file}: node ids`);
      for (const [nodeId, node] of Object.entries(before)) {
        for (const [k, v] of Object.entries(node.inputs)) {
          const slot = typeof v === 'string' ? slotOf.get(v) : undefined;
          assert.deepEqual(after[nodeId].inputs[k], slot ? CUSTOM[slot] : v, `${e.file}: ${nodeId}.${k} (${node.class_type})`);
        }
      }
    }
  });
});

check('a failed render names the slot and the file it depends on; on stock files, or upstream of them, it names none', () => {
  const e = uses[0];
  const stockGraph = JSON.parse(stock(e.file)) as Graph;
  const hit = Object.entries(stockGraph).find(([, n]) => slots.some((s) => Object.values(n.inputs).includes(s.stock)))!;
  const s = slots.find((x) => Object.values(hit[1].inputs).includes(x.stock))!;
  assert.equal(slotFailureNote(stockGraph, hit[0], {}), null);
  assert.equal(slotFailureNote(stockGraph, null, {}), null);
  const g = withEnv(env, () => e.build()) as Graph;
  const named = (note: string | null) => {
    assert.ok(note, `${e.file}: no note`);
    for (const part of [CUSTOM[s.id], slotOrigin(s.id), s.stock]) assert.ok(note!.includes(part), note!);
  };
  const own = slotFailureNote(g, hit[0], env);
  named(own);
  assert.match(own!, /^The failed node loads /);
  // A file of the wrong model can load fine and fail a later node.
  const loadsConfigured = (n: string) => slots.some((x) => Object.values(g[n].inputs).includes(CUSTOM[x.id]));
  const takesFrom = (n: string, from: string) => Object.values(g[n].inputs).some((v) => Array.isArray(v) && String(v[0]) === from);
  const next = Object.keys(g).find((n) => takesFrom(n, hit[0]) && !loadsConfigured(n))!;
  assert.ok(next, `${e.file}: no node takes its input from ${hit[0]}`);
  const fed = slotFailureNote(g, next, env);
  named(fed);
  assert.match(fed!, /^The failed node takes its input from /);
  // A node that takes no input at all and loads no configured file depends on none.
  const root = Object.keys(g).find((n) => !loadsConfigured(n) && !Object.values(g[n].inputs).some(Array.isArray));
  assert.ok(root, `${e.file}: every input-free node loads a configured file`);
  assert.equal(slotFailureNote(g, root!, env), null, `${e.file}: ${root}`);
  const whole = slotFailureNote(g, null, env);
  named(whole);
  assert.match(whole!, /^This render loads /);
});

check(`the bundles holding its files (${holders.join(', ')}) list the configured files, marked, with nothing to download`, () => {
  for (const s of slots) {
    for (const b of holders.filter((h) => byId(BUNDLES, h).files.some((f) => f.file === s.stock))) {
      const f = byId(active, b).files.find((x) => x.file === CUSTOM[s.id]);
      assert.ok(f, `${b}: ${s.id} missing`);
      assert.deepEqual(f!.slot, { id: s.id, origin: slotOrigin(s.id) });
      assert.equal(f!.gb, 0);
      assert.ok(!byId(active, b).files.some((x) => x.file === s.stock), `${b} still lists ${s.stock}`);
    }
  }
});

check('every other bundle and every other slot\'s file is unchanged', () => {
  for (const b of active) if (!holders.includes(b.id)) assert.equal(b, byId(BUNDLES, b.id));
  const files = new Set(active.flatMap((b) => b.files.map((f) => f.file)));
  for (const o of others) assert.ok(files.has(o.stock), o.stock);
});

check('npm run models fetches none of its configured files nor the stock files they replace', () => {
  const fetch = new Set(fetched(active));
  for (const s of slots) {
    assert.ok(!fetch.has(CUSTOM[s.id]), CUSTOM[s.id]);
    assert.ok(!fetch.has(s.stock), s.stock);
  }
});

for (const b of holders) {
  const all = byId(active, b).files.map((f) => f.file);
  const stockFiles = byId(BUNDLES, b).files.map((f) => f.file);

  check(`preflight ${b}: the configured files listed by ComfyUI make it ready, the stock ones alone do not`, () => {
    assert.equal(statusFor(byId(active, b), listing(all), new Set()).ready, true);
    const st = statusFor(byId(active, b), listing(stockFiles), new Set());
    assert.deepEqual(st.missingFiles.map((f) => f.file).sort(), all.filter((f) => !stockFiles.includes(f)).sort());
  });

  check(`preflight ${b}: a configured name must match the listed subfolder`, () => {
    const moved = all.map((f) => f.replace('custom\\', 'other\\'));
    const st = statusFor(byId(active, b), listing(moved), new Set());
    assert.ok(st.missingFiles.length > 0 && st.missingFiles.every((f) => f.slot), st.missingFiles.map((f) => f.file).join());
  });

  check(`preflight ${b}: the message for a missing configured file names its slot, file and variable, and no download`, () => {
    const f = byId(active, b).files.find((x) => x.slot)!;
    const st = statusFor(byId(active, b), listing(all.filter((x) => x !== f.file)), new Set());
    const msg = reasonFor([st], [b])!;
    assert.ok(msg.includes(`${f.file} (models/${f.dir}/; ${slotOrigin(f.slot!.id)})`), msg);
    assert.ok(msg.includes(modelSlot(f.slot!.id).env), msg);
    assert.doesNotMatch(msg, /npm run models/);
    assert.match(msg, /match the name ComfyUI lists/);
  });
}

report();
