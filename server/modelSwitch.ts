/**
 * Unload ComfyUI's models when a render needs a different large model than
 * the ones still loaded, but only when ComfyUI keeps models loaded
 * (--highvram or --gpu-only).
 *
 * Without those flags ComfyUI evicts models by itself when memory runs short.
 * With them it keeps every model it has loaded. Switching apps (LTX-2.5 video,
 * then Qwen-Image, then Qwen-Image-Edit) then piles model after model into
 * memory until the allocation fails. On an APU with unified memory (GPU memory
 * is system memory), that ran Windows out of virtual memory and crashed
 * ComfyUI mid-load.
 *
 * ComfyUI's /free sets a flag its worker reads after each job (or at once when
 * idle). With jobs queued ahead, the flag is set only while the last of them
 * runs, so it is not spent between two of them.
 */
import { config } from './config.js';

/** Loader inputs that load a multi-GB model (diffusion model, checkpoint, text encoder). */
const HEAVY: Record<string, string[]> = {
  UNETLoader: ['unet_name'],
  CheckpointLoaderSimple: ['ckpt_name'],
  CLIPLoader: ['clip_name'],
  LTXAVTextEncoderLoader: ['text_encoder', 'ckpt_name'],
  SeedVR2LoadDiTModel: ['model'],
};

/** The large model files a graph loads. */
export function heavyModels(graph: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const node of Object.values(graph) as { class_type?: string; inputs?: Record<string, unknown> }[]) {
    for (const key of HEAVY[node?.class_type ?? ''] ?? []) {
      const v = node.inputs?.[key];
      if (typeof v === 'string' && v) out.add(v);
    }
  }
  return out;
}

/**
 * True when the next graph needs a large model that is not among the loaded
 * ones. Unknown (null, e.g. after OpenField started) or nothing loaded = no.
 */
export function needsUnload(loaded: Set<string> | null, next: Set<string>): boolean {
  return !!loaded && loaded.size > 0 && [...next].some((m) => !loaded.has(m));
}

let loaded: Set<string> | null = null;

/** ComfyUI's models were unloaded some other way (POST /api/free): nothing is loaded now. */
export function modelsUnloaded(): void {
  loaded = new Set();
}
let keeps: { value: boolean; at: number } | null = null;

/** Whether ComfyUI was started with --highvram or --gpu-only, re-read at most once a minute. */
async function keepsModelsLoaded(): Promise<boolean> {
  if (keeps && Date.now() - keeps.at < 60_000) return keeps.value;
  try {
    const r = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(4000) });
    const argv = ((await r.json()) as { system?: { argv?: unknown } }).system?.argv;
    const value = Array.isArray(argv) && argv.some((a) => a === '--highvram' || a === '--gpu-only');
    keeps = { value, at: Date.now() };
    return value;
  } catch {
    return keeps?.value ?? false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freeModels = () =>
  fetch(`${config.comfyUrl}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

/** The prompt ids ComfyUI is running or holds, in order; null when it cannot be asked. */
async function queuedIds(): Promise<string[] | null> {
  try {
    const r = await fetch(`${config.comfyUrl}/queue`, { signal: AbortSignal.timeout(4000) });
    const q = (await r.json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    return [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].map((e) => String(e[1]));
  } catch {
    return null;
  }
}

/**
 * Set the unload flag once only the last of the `ahead` jobs is left: the
 * worker reads the flag after each job, so it unloads right before ours. A
 * flag set any earlier would be spent between two jobs ahead of ours.
 */
async function freeWhenNext(ahead: Set<string>, pollMs: number): Promise<void> {
  for (;;) {
    const ids = await queuedIds();
    if (!ids || ids.filter((id) => ahead.has(id)).length <= 1) {
      await freeModels();
      return;
    }
    await sleep(pollMs);
  }
}

/**
 * Call before a graph goes to the local ComfyUI. When the graph needs a large
 * model that is not loaded, every model is unloaded before it runs: at once
 * when ComfyUI's queue is empty, else just before the graph's turn (the
 * returned function, called once the graph is submitted, watches the queue in
 * the background). The graph's models are then remembered as the loaded set.
 */
export async function unloadOnModelSwitch(
  graph: Record<string, unknown>, opts = { pollMs: 250, settleMs: 2000 },
): Promise<(() => void) | undefined> {
  const next = heavyModels(graph);
  if (!next.size || !(await keepsModelsLoaded())) return;
  if (!needsUnload(loaded, next)) {
    loaded = new Set([...(loaded ?? []), ...next]);
    return;
  }
  loaded = new Set(next);
  console.log(`[openfield] unloading ComfyUI models before switching to ${[...next].join(', ')}`);
  const ahead = (await queuedIds()) ?? [];
  if (ahead.length) return () => void freeWhenNext(new Set(ahead), opts.pollMs);
  await freeModels();
  // An idle worker acts on the flag right away; give it that moment before the job arrives.
  await sleep(opts.settleMs);
  return undefined;
}

let chain: Promise<unknown> = Promise.resolve();
/** Run submissions one at a time, so each one sees the jobs submitted before it in ComfyUI's queue. */
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}
