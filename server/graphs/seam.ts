/**
 * Seam Doctor graphs. Each fix is a ComfyUI graph like every other take, so it
 * shows in the queue, records a workflow and opens in ComfyUI. Frame math is
 * planned by server/seam.ts from the measured clip.
 *
 *   trim    load only the frames [start, start + frames) and save them. No GPU.
 *   bridge  load the clip, keep the body anchorB..anchorA, render an LTX-2.5
 *           first/last bridge from frame anchorA to frame anchorB, and append
 *           the bridge's inner frames after the body. The clip keeps its exact
 *           length and nothing is blended: every frame is either the original
 *           or newly generated motion.
 *
 * Output is silent: house rule, loops carry no sound.
 */
import { NEGATIVE, SIGMAS_REFINE, buildLtx25Graph, LTX25_FPS } from './ltx25.js';
import { slotFile } from './slots.js';

/** The distilled schedule's low end; a partial re-render starts at sigma and finishes on these. */
const SIGMAS_TAIL = SIGMAS_REFINE.split(',').map(Number).filter((s) => s > 0);

type Graph = Record<string, unknown>;

function loadClip(video: string, frames = 0, skip = 0) {
  return {
    class_type: 'VHS_LoadVideo',
    inputs: {
      video, force_rate: 0, custom_width: 0, custom_height: 0,
      frame_load_cap: frames, skip_first_frames: skip, select_every_nth: 1,
    },
  };
}

function saveClip(images: [string, number], fps: number, prefix: string) {
  return {
    class_type: 'VHS_VideoCombine',
    inputs: {
      images, frame_rate: fps, loop_count: 0, filename_prefix: prefix,
      format: 'video/h264-mp4', pingpong: false, save_output: true,
    },
  };
}

export interface SeamTrimParams {
  /** Input-folder filename or asset token of the loop to fix. */
  video: string;
  start: number;
  frames: number;
  fps?: number;
}

export function buildSeamTrimGraph(p: SeamTrimParams): Graph {
  return {
    src: loadClip(p.video, p.frames, p.start),
    out: saveClip(['src', 0], p.fps ?? LTX25_FPS, 'openfield/seam_trim'),
  };
}

export interface SeamBridgeParams {
  video: string;
  /** Total frames in the clip (the output keeps exactly this many). */
  n: number;
  anchorA: number;
  anchorB: number;
  /** anchorA..anchorB bridge length including both anchors, 8k + 1. */
  bridgeFrames: number;
  width: number;
  height: number;
  prompt: string;
  negative?: string;
  seed: number;
  fps?: number;
  /** Guide strength on the two anchors. */
  guideStrength?: number;
}

export function buildSeamBridgeGraph(p: SeamBridgeParams): Graph {
  const fps = p.fps ?? LTX25_FPS;
  const inner = p.bridgeFrames - 2;
  if (p.anchorA - p.anchorB + 1 + inner !== p.n) throw new Error('bridge plan does not keep the clip length');
  const g: Graph = {
    src: loadClip(p.video, p.n),
    // Body: the frames the fix keeps, anchorB through anchorA.
    body: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: p.anchorB, length: p.anchorA - p.anchorB + 1 } },
    anchorA: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: p.anchorA, length: 1 } },
    anchorB: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: p.anchorB, length: 1 } },
  };
  Object.assign(g, buildLtx25Graph({
    prompt: p.prompt,
    negative: p.negative,
    width: p.width,
    height: p.height,
    seconds: p.bridgeFrames / fps,
    frames: p.bridgeFrames,
    fps,
    seed: p.seed,
    startFrom: ['anchorA', 0],
    endFrom: ['anchorB', 0],
    guideStrength: p.guideStrength,
    nativeGuides: true,
    decodeOnly: true,
  }));
  Object.assign(g, {
    // The bridge's own first and last frames re-render the anchors; drop them.
    inner: { class_type: 'ImageFromBatch', inputs: { image: ['dv', 0], batch_index: 1, length: inner } },
    join: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['body', 0], 'images.image1': ['inner', 0] } },
    out: saveClip(['join', 0], fps, 'openfield/seam_bridge'),
  });
  return g;
}

export interface SeamRegenParams {
  video: string;
  /** Total frames in the clip, 8k + 1 (the output keeps exactly this many). */
  n: number;
  /** Rotation: the re-render runs on clip[h..n-1] + clip[0..h-1], so the old wrap sits at n - h, mid-sequence. */
  h: number;
  /** Frames frozen at each end of the rotated sequence, on the latent grid (start 8j + 1, end 8m). */
  holdStart: number;
  holdEnd: number;
  width: number;
  height: number;
  prompt: string;
  negative?: string;
  seed: number;
  fps?: number;
  /** Re-noise level for the middle, 0.2 (keeps detail) .. 0.85 (redraws it). */
  sigma: number;
}

/**
 * Re-render across the wrap. The loop is rotated so its wrap sits in the
 * middle of one ordinary clip: clip[h..n-1] then clip[0..h-1]. The whole
 * rotated clip is VAE-encoded, its first and last latent frames are frozen
 * (the AV noise mask Extend uses), and everything between is re-noised to
 * `sigma` and denoised in one distilled pass, so the model redraws the old
 * wrap as continuous motion. The result is rotated back.
 *
 * Every output frame comes out of the same decode. Splicing decoded frames
 * into the original file is what defeats a patch: a VAE round trip alone moves
 * fine texture by about 2 levels, ten times an ordinary frame step on a calm
 * loop. The rotated clip's own ends were neighbors in the loop, so the new
 * join at frame h is two frozen, adjacent frames. Nothing is blended.
 */
export function buildSeamRegenGraph(p: SeamRegenParams): Graph {
  const fps = p.fps ?? LTX25_FPS;
  const n = p.n;
  if (n % 8 !== 1) throw new Error('a re-render across the wrap needs an 8k + 1 frame loop');
  const sig = [p.sigma, ...SIGMAS_TAIL.filter((s) => s < p.sigma - 0.05)];
  if (sig.length < 2) sig.push(Math.round(p.sigma * 0.5 * 10000) / 10000);
  return {
    src: loadClip(p.video, n),
    late: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: p.h, length: n - p.h } },
    early: { class_type: 'ImageFromBatch', inputs: { image: ['src', 0], batch_index: 0, length: p.h } },
    rotated: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['late', 0], 'images.image1': ['early', 0] } },

    unet: { class_type: 'UNETLoader', inputs: { unet_name: slotFile('ltx25.transformer'), weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: slotFile('ltx25.textEncoder'), type: 'ltxv', device: 'default' } },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.videoVae') } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: slotFile('ltx25.audioVae') } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? NEGATIVE } },
    cond: { class_type: 'LTXVConditioning', inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps } },

    latV: {
      class_type: 'VAEEncodeTiled',
      inputs: { pixels: ['rotated', 0], vae: ['vvae', 0], tile_size: 512, overlap: 64, temporal_size: 4096, temporal_overlap: 8 },
    },
    latA: { class_type: 'LTXVEmptyLatentAudio', inputs: { frames_number: n, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] } },
    av: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['latV', 0], audio_latent: ['latA', 0] } },
    // 0 = keep, 1 = redraw: the rotated clip's outer latent frames stay as they are.
    mask: {
      class_type: 'LTXVSetAudioVideoMaskByTime',
      inputs: {
        av_latent: ['av', 0], positive: ['cond', 0], negative: ['cond', 1], model: ['unet', 0], vae: ['vvae', 0], audio_vae: ['avae', 0],
        start_time: r4(p.holdStart / fps), end_time: r4((n - p.holdEnd) / fps), video_fps: fps, mask_video: true, mask_audio: true,
        mask_init_value_video: 0, mask_init_value_audio: 0, slope_len: 3,
      },
    },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    sigmas: { class_type: 'ManualSigmas', inputs: { sigmas: [...sig, 0].map((s) => s.toFixed(4)).join(', ') } },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
    guide: { class_type: 'CFGGuider', inputs: { model: ['unet', 0], positive: ['mask', 0], negative: ['mask', 1], cfg: 1.0 } },
    s1: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['noise', 0], guider: ['guide', 0], sampler: ['sampler', 0], sigmas: ['sigmas', 0], latent_image: ['mask', 2] } },
    sep: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s1', 0] } },
    dv: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['sep', 0], vae: ['vvae', 0], tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: 64 },
    },
    // Rotate back: frame 0 is frame 0 again.
    backHead: { class_type: 'ImageFromBatch', inputs: { image: ['dv', 0], batch_index: n - p.h, length: p.h } },
    backTail: { class_type: 'ImageFromBatch', inputs: { image: ['dv', 0], batch_index: 0, length: n - p.h } },
    join: { class_type: 'BatchImagesNode', inputs: { 'images.image0': ['backHead', 0], 'images.image1': ['backTail', 0] } },
    out: saveClip(['join', 0], fps, 'openfield/seam_regen'),
  };
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
