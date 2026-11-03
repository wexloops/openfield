/**
 * `npm run doctor` — one command that answers "why isn't this working?".
 *
 * Checks the things that actually go wrong on a new machine, in the order they
 * go wrong: node version, is ComfyUI answering, does it have the weights, can
 * we write renders anywhere.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { config } from '../server/config.js';
import { getStatus } from '../server/comfy.js';
import { preflight } from '../server/preflight.js';
import { apiUp, ensureProxy, isLocal, stopProxy } from '../server/engine.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bad: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
const pass = (label: string, detail = '') => console.log(`${c.ok(' OK ')} ${label} ${c.dim(detail)}`);
const warn = (label: string, detail = '') => console.log(`${c.warn('NOTE')} ${label} ${c.dim(detail)}`);
const fail = (label: string, detail = '') => {
  failures++;
  console.log(`${c.bad('FAIL')} ${label} ${detail}`);
};

console.log(`\n${c.bold('OpenField doctor')}\n`);

// --- node ---
const major = Number(process.versions.node.split('.')[0]);
if (major >= 22) pass('Node', `v${process.versions.node}`);
else fail('Node', `v${process.versions.node} — OpenField needs Node 22 or newer (the Comfy SDK requires it).`);

// --- engine ---
const status = await getStatus();
if (status.up) {
  const vram = status.vramTotalGb ? `${status.vramTotalGb.toFixed(0)} GB VRAM` : 'VRAM unknown';
  pass('ComfyUI', `${config.comfyUrl} · v${status.version ?? '?'} · ${vram}`);
  const [maj = 0, min = 0] = (status.version ?? '').replace(/^v/, '').split('.').map(Number);
  if (!status.version) warn('ComfyUI version', 'not reported by /system_stats. OpenField needs 0.38 or newer.');
  else if (maj === 0 && min < 38) fail('ComfyUI version', `v${status.version}. OpenField needs 0.38 or newer (update ComfyUI).`);
  if (status.vramTotalGb && status.vramTotalGb < 23) {
    warn('VRAM', `${status.vramTotalGb.toFixed(0)} GB. The video engines here were built on 32 GB; expect offloading, or worse, out-of-memory at HERO sizes.`);
  }
  if (status.otherGpuProcess) {
    warn('GPU', 'Almost no free VRAM while the queue is empty — something else is holding the card.');
  }
} else {
  fail('ComfyUI', `not answering at ${config.comfyUrl}`);
  console.log(c.dim('       Start ComfyUI, or set COMFY_URL in .env if it runs elsewhere.'));
}

// --- Comfy API v2 (every job goes through the Comfy SDK) ---
if (!isLocal()) {
  (await apiUp())
    ? pass('Comfy API v2', `${config.comfyBaseUrl} (cloud)`)
    : fail('Comfy API v2', `${config.comfyBaseUrl} is not answering. Check COMFY_BASE_URL and COMFY_API_KEY.`);
} else if (await apiUp()) {
  pass('Comfy API v2', `${config.comfyBaseUrl} (comfy-api-proxy running)`);
} else if (status.up && (await ensureProxy())) {
  pass('Comfy API v2', `started ${config.proxyBin} on ${config.comfyBaseUrl}`);
  stopProxy();
} else {
  fail('Comfy API v2', `nothing at ${config.comfyBaseUrl}`);
  console.log(c.dim('       pip install comfy-api-proxy  (OpenField starts it for you), or set COMFY_PROXY_BIN.'));
}

// --- weights ---
if (status.up) {
  const bundles = await preflight(true);
  const core = bundles.filter((b) => !b.optional);
  const ready = bundles.filter((b) => b.ready);
  if (ready.length) pass('Models', `ready: ${ready.map((b) => b.id).join(', ')}`);
  for (const b of core.filter((x) => !x.ready)) {
    fail(`Models · ${b.id}`, `${b.missingFiles.length} file(s) missing`);
    for (const f of b.missingFiles) console.log(c.dim(`       models/${f.dir}/${f.file}${f.override ? `  (set by ${f.override} in .env; not downloaded)` : ''}`));
  }
  const optMissing = bundles.filter((b) => b.optional && !b.ready);
  if (optMissing.length) {
    warn('Models', `optional and not installed: ${optMissing.map((b) => b.id).join(', ')}`);
  }
  if (core.every((b) => b.ready)) {
    console.log(c.dim('       Install more with: npm run models -- --only <id>'));
  } else {
    console.log(c.dim('       Fetch the core install with: npm run models'));
  }
}

// --- output folder ---
try {
  mkdirSync(config.outputDir, { recursive: true });
  const probe = join(config.outputDir, '.openfield-write-test');
  writeFileSync(probe, 'x');
  rmSync(probe);
  pass('Output folder', config.outputDir);
} catch (e) {
  fail('Output folder', `${config.outputDir} is not writable — ${e instanceof Error ? e.message : e}`);
}

// --- ffmpeg / ffprobe (clip probing, frame grabs, loop seams, exports) ---
const tool = (bin: string): string | null => {
  try {
    return execFileSync(bin, ['-version'], { encoding: 'utf8', timeout: 10_000 }).split('\n')[0].trim();
  } catch {
    return null;
  }
};
for (const [label, env, bin] of [['ffmpeg', 'FFMPEG_BIN', config.ffmpegBin], ['ffprobe', 'FFPROBE_BIN', config.ffprobeBin]] as const) {
  const v = tool(bin);
  v ? pass(label, `${bin} · ${v.replace(/^\S+ version /, 'v').split(' ')[0]}`) : fail(label, `\`${bin}\` not found. Install ffmpeg, or set ${env} in .env.`);
}
// Stage, Seam Doctor and the HDR / alpha exports encode with these; some builds (conda's) ship without libx264.
if (tool(config.ffmpegBin)) {
  let encoders = '';
  try { encoders = execFileSync(config.ffmpegBin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 }); } catch { /* reported below */ }
  const missing = ['libx264', 'prores_ks'].filter((e) => !new RegExp(`\\b${e}\\b`).test(encoders));
  missing.length
    ? fail('ffmpeg encoders', `${config.ffmpegBin} has no ${missing.join(' or ')}. Install a full ffmpeg build (e.g. apt install ffmpeg) and set FFMPEG_BIN in .env.`)
    : pass('ffmpeg encoders', 'libx264, prores_ks');
}

// --- HuggingFace token (only the model installer uses it) ---
if (process.env.HF_TOKEN) pass('HF_TOKEN', 'set');
else warn('HF_TOKEN', 'unset. Gated repos (LTX-2.x) refuse anonymous downloads: accept the license on the model page, then set a read token in .env for `npm run models`.');

// --- optional extras ---
if (config.comfyModelsDir) {
  existsSync(config.comfyModelsDir)
    ? pass('COMFY_MODELS_DIR', config.comfyModelsDir)
    : fail('COMFY_MODELS_DIR', `${config.comfyModelsDir} does not exist — the installer writes here.`);
} else {
  warn('COMFY_MODELS_DIR', 'unset — `npm run models` needs it. Not needed to run the app.');
}
if (config.comfyLaunch) pass('COMFY_LAUNCH', 'set — START ENGINE will work');
else warn('COMFY_LAUNCH', 'unset — start ComfyUI yourself; START ENGINE stays disabled.');
if (config.whisperBin) pass('WHISPER_BIN', config.whisperBin);
else warn('WHISPER_BIN', 'unset — takes will carry no dialogue transcript. Optional.');

console.log(
  failures === 0
    ? c.ok(`\nReady. \`npm run dev\`, then open http://localhost:${config.uiPort}  (or \`npm run build && npm start\`: http://localhost:${config.port})\n`)
    : c.bad(`\n${failures} problem(s) above. Fix those first.\n`)
);
process.exit(failures ? 1 : 0);
