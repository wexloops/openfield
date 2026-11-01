/**
 * The machine-wide video decode mode (src/videoDecode.ts): a choice made in
 * Setup, else OPENFIELD_VIDEO_DECODE, else what the GPU needs (AMD = chunks).
 *
 * The graph builders always write a whole-clip decode, so exported workflows
 * stay the same everywhere. In chunks mode, engine.submit rewrites every
 * VAEDecodeTiled of a graph that takes more than 64 frames per call just
 * before the graph goes to ComfyUI.
 */
import { config } from './config.js';
import { meta } from './jobs.js';
import * as comfy from './comfy.js';
import {
  DECODE_CHUNK_FRAMES, DECODE_CHUNK_OVERLAP, gpuVideoDecode, isVideoDecode, type VideoDecode, type VideoDecodeState,
} from '../src/videoDecode.js';

const KEY = 'video_decode';

let gpu: { mode: VideoDecode; at: number } | null = null;
/** The GPU's default, re-read at most once a minute. Engine down: the last answer, or the whole clip. */
async function gpuDefault(): Promise<VideoDecode> {
  if (gpu && Date.now() - gpu.at < 60_000) return gpu.mode;
  const st = await comfy.getStatus().catch(() => null);
  if (st?.up && st.gpu) gpu = { mode: gpuVideoDecode(st.gpu), at: Date.now() };
  return gpu?.mode ?? 'whole';
}

/** What the mode would be without a Setup choice. */
async function autoMode(): Promise<{ mode: VideoDecode; source: 'env' | 'gpu' }> {
  if (config.videoDecode) return { mode: config.videoDecode, source: 'env' };
  return { mode: await gpuDefault(), source: 'gpu' };
}

export async function videoDecodeState(): Promise<VideoDecodeState> {
  const auto = await autoMode();
  const chosen = meta.get(KEY);
  if (isVideoDecode(chosen)) return { mode: chosen, source: 'user', auto: auto.mode };
  return { mode: auto.mode, source: auto.source, auto: auto.mode };
}

export const currentVideoDecode = async (): Promise<VideoDecode> => (await videoDecodeState()).mode;

/** Set the Setup choice; null goes back to the default. */
export function setVideoDecode(m: VideoDecode | null) {
  if (m) meta.set(KEY, m);
  else meta.delete(KEY);
}

type Node = { class_type?: unknown; inputs?: Record<string, unknown> };

/**
 * Switch every VAEDecodeTiled in a graph that decodes more than
 * DECODE_CHUNK_FRAMES frames per call to chunks of that size, in place: the
 * whole-clip decodes, and the 128-frame chunks of Stage and HDR. A decode in
 * chunks of that size or smaller (Cast) is left as it is. Returns how many
 * nodes changed.
 */
export function chunkVideoDecodes(graph: Record<string, unknown>): number {
  let n = 0;
  for (const node of Object.values(graph) as Node[]) {
    if (node?.class_type !== 'VAEDecodeTiled' || !node.inputs) continue;
    const size = node.inputs.temporal_size;
    if (typeof size !== 'number' || size <= DECODE_CHUNK_FRAMES) continue;
    node.inputs.temporal_size = DECODE_CHUNK_FRAMES;
    node.inputs.temporal_overlap = DECODE_CHUNK_OVERLAP;
    n++;
  }
  return n;
}
