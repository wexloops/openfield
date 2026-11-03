/**
 * Upscale app graphs. Three modes, one source (a video or a still):
 *
 *   sharpen  frames -> ESRGAN 4x -> area down to a clean 2x -> optional RIFE 2x
 *            frames -> reassemble with the ORIGINAL audio. Fast and faithful.
 *   redraw   frames -> SeedVR2 (one-step diffusion restoration, 3B or 7B) at a
 *            1080/1440 short edge, color matched back to the source. Rebuilds
 *            real detail. Tiled VAE + CPU offload so it fits a 32 GB card.
 *   dream    frames -> LTX-2.5 video VAE encode at half the output size ->
 *            LTXVLatentUpsampler x2 -> re-noise to the Creativity sigma ->
 *            distilled refine with a prompt -> decode, original audio muxed back.
 *
 * Params verified against this install's /object_info (ComfyUI 0.38.2,
 * VideoHelperSuite, ComfyUI-SeedVR2_VideoUpscaler, Frame-Interpolation).
 * VHS fails to load a silent file's audio output, so audio is only wired when
 * the source has a track.
 */
import {
  NEGATIVE, SIGMAS_REFINE,
} from './ltx25.js';
import { slotFile } from './slots.js';

type Graph = Record<string, unknown>;
type Link = [string, number];

/** What the graph reads. `file` is a ComfyUI input filename or an `asset:<id>` token. */
export interface UpscaleSource {
  kind: 'video' | 'image';
  file: string;
  /** Carry the source audio through (video only). */
  withAudio?: boolean;
  /** Source frame rate. OpenField's own takes are 24. */
  fps?: number;
  /** Load at most this many frames (0 = all). */
  frameCap?: number;
}

export const SHARPEN_FILES = { esrgan: 'RealESRGAN_x4plus.pth', ultrasharp: '4x-UltraSharp.pth' } as const;
export const SEEDVR2_FILES = {
  '3b': 'seedvr2_ema_3b_fp16.safetensors',
  '7b': 'seedvr2_ema_7b_fp16.safetensors',
  vae: 'ema_vae_fp16.safetensors',
} as const;

function load(g: Graph, src: UpscaleSource, forceRate = 0): { frames: Link; audio?: Link } {
  if (src.kind === 'image') {
    g.load = { class_type: 'LoadImage', inputs: { image: src.file } };
    return { frames: ['load', 0] };
  }
  g.load = {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video: src.file,
      force_rate: forceRate,
      custom_width: 0,
      custom_height: 0,
      frame_load_cap: src.frameCap ?? 0,
      skip_first_frames: 0,
      select_every_nth: 1,
    },
  };
  return { frames: ['load', 0], audio: src.withAudio ? ['load', 2] : undefined };
}

function save(g: Graph, src: UpscaleSource, frames: Link, audio: Link | undefined, fps: number, prefix: string) {
  if (src.kind === 'image') {
    g.out = { class_type: 'SaveImage', inputs: { images: frames, filename_prefix: prefix } };
    return;
  }
  g.out = {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images: frames,
      ...(audio ? { audio } : {}),
      frame_rate: fps,
      loop_count: 0,
      filename_prefix: prefix,
      format: 'video/h264-mp4',
      pingpong: false,
      save_output: true,
    },
  };
}

// ---------- sharpen ----------

export interface SharpenParams {
  source: UpscaleSource;
  model: keyof typeof SHARPEN_FILES;
  /** Net scale after the 4x model, normally 2 (lower when the long edge would pass the cap). */
  scale: number;
  /** Double the frame count with RIFE (video only). */
  rife: boolean;
}

export function buildSharpenGraph(p: SharpenParams): Graph {
  const g: Graph = {};
  const rife = p.rife && p.source.kind === 'video';
  // The whole clip goes through at once: VHS's meta-batch streaming re-queues
  // the prompt per batch, which the Comfy SDK sees as a job with no output.
  // The server caps the frame count instead (sharpenMaxFrames).
  const { frames: input, audio } = load(g, p.source);
  Object.assign(g, {
    um: { class_type: 'UpscaleModelLoader', inputs: { model_name: SHARPEN_FILES[p.model] } },
    up: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['um', 0], image: input } },
    // Area is a clean box filter for a 2x reduction and runs on the tensor;
    // lanczos goes through PIL a frame at a time and took minutes on a 5 s clip.
    half: {
      class_type: 'ImageScaleBy',
      inputs: { image: ['up', 0], upscale_method: 'area', scale_by: Math.round((p.scale / 4) * 10000) / 10000 },
    },
  });
  let frames: Link = ['half', 0];
  let fps = p.source.fps ?? 24;
  if (rife) {
    g.rife = {
      class_type: 'RIFE VFI',
      inputs: {
        frames, ckpt_name: 'rife47.pth', clear_cache_after_n_frames: 10,
        multiplier: 2, fast_mode: true, ensemble: true, scale_factor: 1.0,
        // Required by current Frame-Interpolation; older versions ignore them.
        dtype: 'float32', torch_compile: false, batch_size: 1,
      },
    };
    frames = ['rife', 0];
    fps *= 2;
  }
  save(g, p.source, frames, audio, fps, 'OpenField_UP');
  return g;
}

// ---------- redraw (SeedVR2) ----------

export interface RedrawParams {
  source: UpscaleSource;
  model: '3b' | '7b';
  /** Target short edge. */
  resolution: number;
  /** Cap on the long edge. */
  maxResolution: number;
  /** Frames per SeedVR2 batch, 4n+1. */
  batchSize: number;
  color: 'lab' | 'wavelet' | 'none';
  seed: number;
}

/** SeedVR2 batches must be 4n+1 frames. */
export const snap4n1 = (n: number) => Math.max(1, Math.floor((Math.max(1, n) - 1) / 4) * 4 + 1);

/**
 * Batch size for a clip of `frames`: as large as fits (temporal consistency
 * and speed both improve with it), split into near-equal batches so the last
 * one is not a stub. `cap` is what fits in VRAM at the chosen model/size.
 */
export function redrawBatch(frames: number, cap: number): number {
  if (frames <= 1) return 1;
  const n = Math.ceil(frames / cap);
  const per = Math.ceil(frames / n);
  // Round up to 4n+1 so n batches cover the clip.
  return Math.min(snap4n1(cap), Math.ceil((per - 1) / 4) * 4 + 1);
}

export function buildRedrawGraph(p: RedrawParams): Graph {
  const g: Graph = {};
  const { frames, audio } = load(g, p.source);
  Object.assign(g, {
    dit: {
      class_type: 'SeedVR2LoadDiTModel',
      inputs: {
        model: SEEDVR2_FILES[p.model],
        device: 'cuda:0',
        blocks_to_swap: 0,
        swap_io_components: false,
        // Offload to RAM between phases so the VAE has the card to itself.
        offload_device: 'cpu',
        cache_model: false,
        attention_mode: 'sdpa',
      },
    },
    vae: {
      class_type: 'SeedVR2LoadVAEModel',
      inputs: {
        model: SEEDVR2_FILES.vae,
        device: 'cuda:0',
        // Untiled encode/decode at 1080p overflows 32 GB and pages to system RAM (minutes per batch).
        encode_tiled: true,
        encode_tile_size: 512,
        encode_tile_overlap: 64,
        decode_tiled: true,
        decode_tile_size: 512,
        decode_tile_overlap: 64,
        tile_debug: 'false',
        offload_device: 'cpu',
        cache_model: false,
      },
    },
    redraw: {
      class_type: 'SeedVR2VideoUpscaler',
      inputs: {
        image: frames,
        dit: ['dit', 0],
        vae: ['vae', 0],
        seed: p.seed % 4294967295,
        resolution: p.resolution,
        max_resolution: p.maxResolution,
        batch_size: p.source.kind === 'image' ? 1 : snap4n1(p.batchSize),
        uniform_batch_size: false,
        color_correction: p.color,
        temporal_overlap: p.source.kind === 'image' ? 0 : 2,
        prepend_frames: 0,
        input_noise_scale: 0,
        latent_noise_scale: 0,
        offload_device: 'cpu',
        enable_debug: false,
      },
    },
  });
  save(g, p.source, ['redraw', 0], audio, p.source.fps ?? 24, 'OpenField_UP');
  return g;
}

// ---------- dream (LTX-2.5) ----------

export interface DreamParams {
  source: UpscaleSource & { kind: 'video' };
  /** What to add or reimagine. */
  prompt: string;
  negative?: string;
  /** Refine start sigma, 0.2 (faithful) .. 0.85 (reimagined). */
  creativity: number;
  /** Delivered size, 64-aligned (2x a 32-aligned base). */
  width: number;
  height: number;
  /** n % 8 === 1. */
  frames: number;
  seed: number;
}

export const DREAM_FPS = 24;

/**
 * Refine schedule from the Creativity sigma down to zero. At the top end this
 * is exactly ltx25's SIGMAS_REFINE (the distilled refine pass); lower starts
 * keep the template's own sigmas that sit below the start, and always take at
 * least two steps.
 */
export function dreamSigmas(creativity: number): string {
  const c = Math.max(0.05, Math.min(0.95, creativity));
  const tail = SIGMAS_REFINE.split(',').map(Number).filter((s) => s > 0 && s < c - 0.05);
  const pts = [c, ...tail];
  if (pts.length < 2) pts.push(Math.round(c * 0.5 * 10000) / 10000);
  return [...pts, 0].map((s) => s.toFixed(4)).join(', ');
}

export function buildDreamGraph(p: DreamParams): Graph {
  const g: Graph = {};
  // Every source runs at LTX's native 24 fps; VHS resamples and trims the audio to match.
  const { frames, audio } = load(g, { ...p.source, frameCap: p.frames }, DREAM_FPS);
  const baseW = p.width / 2;
  const baseH = p.height / 2;
  Object.assign(g, {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('ltx25.textEncoder'), type: 'ltxv', device: 'default' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.audioVae') } },

    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: DREAM_FPS } },

    // Source frames at the half-size base the latent upsampler doubles.
    fit: { class_type: 'ImageScale', inputs: { image: frames, upscale_method: 'lanczos', width: baseW, height: baseH, crop: 'center' } },
    enc: {
      class_type: 'VAEEncodeTiled',
      inputs: { pixels: ['fit', 0], vae: ['vvae', 0], tile_size: 512, overlap: 64, temporal_size: 4096, temporal_overlap: 8 },
    },
    upmodel: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: slotFile('ltx25.upscaler') } },
    up: { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['enc', 0], upscale_model: ['upmodel', 0], vae: ['vvae', 0] } },

    // The model is audio-video, so the sampler wants an AV latent. The audio it
    // samples is thrown away; the source track is muxed back at the end.
    latA: {
      class_type: 'LTXVEmptyLatentAudio',
      inputs: { frames_number: p.frames, frame_rate: DREAM_FPS, batch_size: 1, audio_vae: ['avae', 0] },
    },
    cat: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['up', 0], audio_latent: ['latA', 0] } },
    sig: { class_type: 'ManualSigmas', inputs: { sigmas: dreamSigmas(p.creativity) } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    guide: {
      class_type: 'LTXVDualCFGGuider',
      inputs: { model: ['unet', 0], positive: ['cond', 0], negative: ['cond', 1], video_cfg: 1, audio_cfg: 1 },
    },
    // SamplerCustomAdvanced noises the latent to the first sigma before
    // denoising: that re-noise is what Creativity controls.
    refine: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['noise', 0], guider: ['guide', 0], sampler: ['sampler', 0], sigmas: ['sig', 0], latent_image: ['cat', 0] },
    },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['refine', 0] } },
    dv: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['sep', 0], vae: ['vvae', 0], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 32 },
    },
  });
  save(g, p.source, ['dv', 0], audio, DREAM_FPS, 'OpenField_UP');
  return g;
}
