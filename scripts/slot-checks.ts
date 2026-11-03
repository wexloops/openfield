/**
 * Shared by the model slot tests (scripts/test-model-slots.ts for all slots,
 * scripts/test-slot-family.ts for one family): the check runner, a configured
 * file name for every slot, and the exported workflows built on the stock files.
 * Importing it changes nothing; each test clears the slot variables itself.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { MODEL_SLOTS, clearSlotOverrides, type ModelSlot } from '../server/graphs/slots.js';
import { BUNDLES, downloadPlan, type Bundle } from '../server/models.js';
import { ENTRIES, OUT } from './export-workflows.js';

let passed = 0;
let failed = 0;
export function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : e}`);
  }
}

/** Print the count and exit non-zero on any failure. */
export function report(): void {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export const STOCK_NAMES = MODEL_SLOTS.map((s) => s.stock);
// Names as ComfyUI on Windows lists files in a subfolder.
export const CUSTOM = Object.fromEntries(MODEL_SLOTS.map((s) => [s.id, `custom\\${s.id}.safetensors`])) as Record<string, string>;
export const envFor = (slots: readonly ModelSlot[]): NodeJS.ProcessEnv => Object.fromEntries(slots.map((s) => [s.env, CUSTOM[s.id]]));

/** Run fn with exactly these slot variables set in this process, then clear every slot variable. */
export function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  clearSlotOverrides();
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    clearSlotOverrides();
  }
}

export { ENTRIES };
export const built = (e: (typeof ENTRIES)[number]) => JSON.stringify(e.build(), null, 2) + '\n';
export const committed = (file: string) => readFileSync(join(OUT, `${file}.json`), 'utf8').replace(/\r\n/g, '\n');

let stockGraphs: Map<string, string> | undefined;
/** An exported workflow built on the stock files, as JSON text, by file name. */
export function stock(file: string): string {
  stockGraphs ??= withEnv({}, () => new Map(ENTRIES.map((e) => [e.file, built(e)])));
  return stockGraphs.get(file)!;
}
export const loads = (file: string, name: string) => stock(file).includes(JSON.stringify(name));

export const byId = (bs: Bundle[], id: string) => bs.find((b) => b.id === id)!;
const DIRS = [...new Set(BUNDLES.flatMap((b) => b.files.map((f) => f.dir)))];
/** What preflight sees: each loader's list as ComfyUI returns it. */
export const listing = (names: string[]) => Object.fromEntries(DIRS.map((d) => [d, new Set(names)]));
/** The files `npm run models` would fetch for these bundles if none were installed (downloadPlan). */
export const fetched = (bs: Bundle[]) => downloadPlan(bs.flatMap((b) => b.files)).fetch.map((f) => f.file);
