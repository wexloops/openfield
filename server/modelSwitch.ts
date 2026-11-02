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
 * ComfyUI's /free sets a flag its worker acts on as soon as it is idle, or
 * right after the job it is running; either way before the next job starts.
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

/**
 * Call before a graph goes to the local ComfyUI. Unloads every model first
 * when the graph needs a large model that is not loaded yet, then remembers
 * the graph's models as the loaded set.
 */
export async function unloadOnModelSwitch(graph: Record<string, unknown>): Promise<void> {
  const next = heavyModels(graph);
  if (!next.size) return;
  if (await keepsModelsLoaded()) {
    if (needsUnload(loaded, next)) {
      await fetch(`${config.comfyUrl}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: true, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      console.log(`[openfield] unloading ComfyUI models before switching to ${[...next].join(', ')}`);
      // An idle worker acts on the flag right away; give it that moment before the job arrives.
      await new Promise((r) => setTimeout(r, 2000));
      loaded = new Set(next);
    } else {
      loaded = new Set([...(loaded ?? []), ...next]);
    }
  }
}
