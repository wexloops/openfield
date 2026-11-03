/**
 * How the final VAE decode of a video runs: the whole clip in one call per
 * spatial tile, or in chunks of frames.
 *
 * Chunks keep each GPU call short and the decode's peak memory low, at about
 * the same speed. On AMD GPUs (ROCm), one call over a whole 5 s or longer
 * clip has crashed the HIP runtime mid-decode, after sampling had finished;
 * in chunks the same renders went through. So the default is chunks on AMD
 * and the whole clip elsewhere, as before.
 *
 * The machine-wide choice lives on the server (GET/PUT /api/settings), like
 * the render size: a pick in Setup, else OPENFIELD_VIDEO_DECODE, else the GPU.
 * No imports, so the pages and the server can both use it.
 */

export type VideoDecode = 'whole' | 'chunked';

export interface VideoDecodeDef {
  id: VideoDecode;
  /** As Setup shows it. */
  label: string;
  /** One line on what it does. */
  note: string;
}

export const VIDEO_DECODES: readonly VideoDecodeDef[] = [
  { id: 'whole', label: 'Whole clip', note: 'Decodes each tile over the whole clip in one go. The default on NVIDIA and other GPUs.' },
  { id: 'chunked', label: 'In chunks', note: 'Decodes 64 frames at a time, blended where they overlap. Shorter GPU calls, lower peak memory, about the same speed. The default on AMD.' },
];

export const isVideoDecode = (v: unknown): v is VideoDecode => v === 'whole' || v === 'chunked';

/** A mode from free text (an env var, a request field), or undefined. */
export const parseVideoDecode = (v: unknown): VideoDecode | undefined => {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : v;
  return isVideoDecode(t) ? t : undefined;
};

/** The default for a GPU, from the name ComfyUI reports. AMD (ROCm) = chunks; anything else or unknown = whole clip. */
export function gpuVideoDecode(gpuName: string | undefined): VideoDecode {
  return /\b(amd|radeon)\b/i.test(gpuName ?? '') ? 'chunked' : 'whole';
}

/** Frames per chunk, and the frames two chunks share (blended), in VAEDecodeTiled's temporal inputs. */
export const DECODE_CHUNK_FRAMES = 64;
export const DECODE_CHUNK_OVERLAP = 16;

export type VideoDecodeSource = 'user' | 'env' | 'gpu';
export interface VideoDecodeState {
  mode: VideoDecode;
  source: VideoDecodeSource;
  /** What it would be without a Setup choice. */
  auto: VideoDecode;
}
