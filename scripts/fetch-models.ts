/**
 * Model installer — downloads the weights OpenField's graphs ask for and puts
 * them where ComfyUI looks.
 *
 * Reads server/models.ts, the same manifest the app's preflight uses, so what
 * this fetches and what the app expects cannot drift apart.
 *
 *   npm run models -- --list              what exists, what is missing
 *   npm run models                        the core install (LTX-2.5 + Qwen)
 *   npm run models -- --only h3,h3-turbo  named bundles
 *   npm run models -- --all               everything, optional bundles included
 *   npm run models -- --dry-run           print the plan, download nothing
 *
 * Downloads run through curl with resume (-C -) into <file>.part, renamed
 * into place only when curl finishes, so an interrupted 21GB pull picks up
 * where it stopped and is never mistaken for a finished file.
 *
 * A file set for a model slot in .env (server/graphs/slots.ts) is checked for
 * under its configured name and never downloaded.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { activeBundles, bundleGb, downloadPlan, type Bundle, type ModelFile } from '../server/models.js';
import { config } from '../server/config.js';
import { getStatus } from '../server/comfy.js';
import { preflight } from '../server/preflight.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const DEST = valueOf('--dest') || config.comfyModelsDir;
const TOKEN = process.env.HF_TOKEN || '';
const DRY = has('--dry-run');
// The manifest with any file a slot variable sets in place of the stock one it
// replaces: such a file is checked for, never downloaded.
const BUNDLES = activeBundles();

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function selectedBundles(): Bundle[] {
  const only = valueOf('--only');
  if (only) {
    const ids = only.split(',').map((s) => s.trim());
    const picked = BUNDLES.filter((b) => ids.includes(b.id));
    const unknown = ids.filter((id) => !BUNDLES.some((b) => b.id === id));
    if (unknown.length) {
      console.error(c.bad(`Unknown bundle(s): ${unknown.join(', ')}`));
      console.error(`Known: ${BUNDLES.map((b) => b.id).join(', ')}`);
      process.exit(1);
    }
    return picked;
  }
  if (has('--all')) return BUNDLES;
  return BUNDLES.filter((b) => !b.optional);
}

// A configured name may carry a subfolder, with either slash.
const target = (f: ModelFile) => join(DEST, f.dir, ...f.file.split(/[\\/]/));

/** On disk under DEST, and not a zero-length stub from a failed run. */
const onDisk = (f: ModelFile) => !!DEST && existsSync(target(f)) && statSync(target(f)).size > 0;

/**
 * Whether a file is already installed.
 *
 * The running engine is the authority, not the filesystem: ComfyUI's
 * extra_model_paths.yaml routinely puts weights on another drive entirely, and
 * a disk-only check then reports a fully working install as empty. Fall back to
 * looking under DEST only when the engine is not answering.
 */
type InstalledCheck = { has: (f: ModelFile) => boolean; source: string };

async function installedCheck(): Promise<InstalledCheck> {
  if ((await getStatus()).up) {
    // preflight reports what is absent; everything in the manifest it does not
    // name is therefore visible to the engine.
    const absent = new Set(
      (await preflight(true)).flatMap((b) => b.missingFiles.map((f) => f.file))
    );
    return { has: (f) => !absent.has(f.file), source: `the running engine at ${config.comfyUrl}` };
  }
  return { has: onDisk, source: DEST ? `files under ${DEST}` : 'nothing (no engine, no --dest)' };
}

function requireDest(): void {
  if (DEST) return;
  console.error(c.bad('Where is ComfyUI?'));
  console.error(`
Set COMFY_MODELS_DIR in .env (or pass --dest), pointing at your ComfyUI models
folder — the one containing diffusion_models/, text_encoders/, vae/, loras/.

  COMFY_MODELS_DIR=/home/you/ComfyUI/models
  COMFY_MODELS_DIR=/mnt/c/path/to/ComfyUI/models # WSL, Windows install
`);
  process.exit(1);
}

/** Custom node packs these bundles need, one entry per pack. */
function packsOf(bundles: Bundle[]): { pack: string; url: string; bundles: string[] }[] {
  const by = new Map<string, { pack: string; url: string; bundles: string[] }>();
  for (const b of bundles) {
    for (const n of b.nodes ?? []) {
      const e = by.get(n.pack) ?? { pack: n.pack, url: n.url, bundles: [] };
      if (!e.bundles.includes(b.id)) e.bundles.push(b.id);
      by.set(n.pack, e);
    }
  }
  return [...by.values()];
}

async function list(): Promise<void> {
  const check = await installedCheck();
  console.log(`\n${c.bold('OpenField model bundles')}`);
  console.log(c.dim(`checked against ${check.source}\n`));
  for (const b of BUNDLES) {
    const missing = b.files.filter((f) => !check.has(f));
    const state = missing.length === 0 ? c.ok(' OK  ') : c.bad('MISS ');
    console.log(`${state} ${c.bold(b.id.padEnd(10))} ${b.label}  ${c.dim(`${bundleGb(b)} GB${b.optional ? ' · optional' : ''}`)}`);
    if (b.licenseWarning) console.log(`       ${c.warn(b.licenseWarning)}`);
    for (const f of missing) console.log(c.dim(`       missing  models/${f.dir}/${f.file}${f.slot ? `  (${f.slot.origin})` : ''}`));
    for (const n of packsOf([b])) console.log(c.dim(`       needs custom nodes: ${n.pack}  ${n.url}`));
  }
  console.log('');
}

function curl(url: string, dest: string): Promise<number> {
  const a = ['-L', '--fail', '--progress-bar', '-C', '-', '-o', dest];
  if (TOKEN) a.push('-H', `Authorization: Bearer ${TOKEN}`);
  a.push(url);
  return new Promise((resolve) => {
    const p = spawn('curl', a, { stdio: 'inherit' });
    p.on('error', () => resolve(127));
    p.on('close', (code) => resolve(code ?? 1));
  });
}

async function download(f: ModelFile): Promise<boolean> {
  const dir = join(DEST, f.dir);
  const dest = target(f);
  const url = `https://huggingface.co/${f.repo}/resolve/main/${f.path}`;
  console.log(`\n${c.bold(f.file)} ${c.dim(`${f.gb} GB → models/${f.dir}/`)}`);
  console.log(c.dim(`  ${url}`));
  if (DRY) return true;
  mkdirSync(dir, { recursive: true });
  const part = `${dest}.part`;
  const code = await curl(url, part);
  if (code === 0) {
    renameSync(part, dest);
    return true;
  }
  if (code === 127) {
    console.error(c.bad('  curl not found — install curl, or download the file by hand from the URL above.'));
  } else if (f.gated && !TOKEN) {
    console.error(c.bad(`  Failed (${code}). ${f.repo} is GATED:`));
    console.error(`  1. Open https://huggingface.co/${f.repo} and accept the license.`);
    console.error('  2. Put a token in your environment: HF_TOKEN=hf_...');
  } else {
    console.error(c.bad(`  curl exited ${code} — partial file kept, re-run to resume.`));
  }
  return false;
}

async function main(): Promise<void> {
  if (has('--list')) {
    await list();
    return;
  }
  requireDest();

  const check = await installedCheck();
  const bundles = selectedBundles();
  // Bundles share files (the edit bundle reuses the qwen encoder, VAE and
  // LoRA); fetch each file once.
  const wanted = [...new Map(bundles.flatMap((b) => b.files).map((f) => [`${f.dir}/${f.file}`, f])).values()];
  const absent = wanted.filter((f) => !check.has(f));
  const { fetch: todo, configured } = downloadPlan(absent);
  const skipped = wanted.length - absent.length;

  console.log(`\n${c.bold('OpenField models')} → ${DEST}`);
  console.log(`Bundles: ${bundles.map((b) => b.id).join(', ')}`);
  console.log(c.dim(`Already-installed check: ${check.source}`));
  if (skipped) console.log(c.dim(`${skipped} file(s) already present, skipping.`));

  for (const b of bundles) {
    if (b.licenseWarning) console.log(`\n${c.warn(`[${b.id}] ${b.licenseWarning}`)}`);
  }
  for (const n of packsOf(bundles)) {
    console.log(c.warn(`[${n.bundles.join(', ')}] also needs the ${n.pack} custom nodes: ${n.url}`));
  }

  for (const f of configured) {
    console.log(c.warn(`Not found: models/${f.dir}/${f.file}, ${f.slot.origin}. It is not downloaded; put it there, or fix the name in .env.`));
  }

  if (!todo.length) {
    if (configured.length) {
      console.log(c.bad(`\nNothing to download, but ${configured.length} configured file(s) are missing (above).\n`));
      process.exit(1);
    }
    console.log(c.ok('\nNothing to download — every file for these bundles is already in place.\n'));
    return;
  }
  const gb = Math.round(todo.reduce((n, f) => n + f.gb, 0) * 10) / 10;
  console.log(`\n${todo.length} file(s), about ${gb} GB to fetch.${DRY ? c.dim(' (dry run)') : ''}`);
  if (todo.some((f) => f.gated) && !TOKEN) {
    console.log(c.warn('Some of these are gated repos and HF_TOKEN is not set — those will fail.'));
  }

  const failed: ModelFile[] = [];
  for (const f of todo) if (!(await download(f))) failed.push(f);

  if (failed.length) {
    console.error(c.bad(`\n${failed.length} file(s) failed: ${failed.map((f) => f.file).join(', ')}`));
    console.error('Re-run the same command to resume — completed files are skipped.\n');
    process.exit(1);
  }
  if (configured.length) {
    console.log(c.bad(`\nDownloads done, but ${configured.length} configured file(s) are still missing (listed before the downloads).\n`));
    process.exit(1);
  }
  console.log(c.ok(`\nDone. Restart ComfyUI so it rescans its model folders, then re-check in OpenField.\n`));
}

await main();
