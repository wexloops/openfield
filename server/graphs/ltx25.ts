/**
 * LTX-2.5 graph builder — faithful port of the official ComfyUI templates
 * video_ltx2_5_{t2v,i2v,flf2v} (ComfyUI >= 0.32.0, released 2026-08-11).
 *
 * Three modes, picked from which reference images are supplied:
 *   t2v   — no images.        Two-stage: base @ half res -> 2x latent upsample -> refine.
 *   i2v   — startImage only.  Same two-stage, with the frame injected at both stages.
 *   flf2v — start + end image. SINGLE stage at full res, guided at frame 0 and frame -1.
 *
 * flf2v with startImage === endImage is the seamless-loop primitive: the model
 * closes the loop itself, so no post dissolve is needed.
 *
 * Differences from the 2.3 builder in ./ltx.ts (which stays untouched):
 *   - 24fps native, not 25.
 *   - Standalone UNETLoader + CLIPLoader + 2x VAELoader. No donor checkpoint,
 *     and no separate distilled LoRA — distillation is baked into the weights.
 *   - LTXVDualCFGGuider (separate video/audio CFG) replaces CFGGuider.
 *   - euler_ancestral in both passes.
 */

import { ltx25Files } from './ltxfiles.js';

export type Ltx25Mode = 't2v' | 'i2v' | 'flf2v';

export interface Ltx25Params {
  prompt: string;
  negative?: string;
  width: number;              // final output size
  height: number;
  seconds: number;
  seed: number;
  fps?: number;               // default 24 (LTX-2.5 native)
  startImage?: string;        // input-folder filename
  endImage?: string;          // input-folder filename -> flf2v
  /** Keep the generated audio track in the muxed output. Off by default:
   *  house rule is no audio on visual loops. The audio latent is always
   *  sampled regardless, because the model is natively audio-video and the
   *  sampler expects the concatenated AV latent. */
  withAudio?: boolean;
  videoCfg?: number;          // distilled = 1
  audioCfg?: number;          // distilled = 1
  transformer?: string;       // override the default checkpoint
  filenamePrefix?: string;
  /** Plain LoRAs chained after the transformer (LoraLoaderModelOnly each).
   *  A `trigger` is injected into the prompt unless the prompt already has it. */
  loras?: Ltx25Lora[];
  /** In-context LoRA + its reference clip (video-to-video effects). Switches the
   *  build to a single stage at full resolution, guide aligned at frame 0, and
   *  crops the guide back off before decode (the Reshoot / official V2V
   *  IC-LoRA recipe). The loader's own latent_downscale_factor feeds the guide. */
  icLora?: Ltx25IcLora;
  /** Exact frame count (n % 8 === 1) in place of `seconds`. */
  frames?: number;
  /** Start / end frame from another node's IMAGE output instead of an input
   *  file (the Seam Doctor's bridge takes its anchors from the clip itself).
   *  Either one set turns on the matching guide, like startImage / endImage. */
  startFrom?: [string, number];
  endFrom?: [string, number];
  /** flf2v guide strength at both ends. Default 0.7 (the official template). */
  guideStrength?: number;
  /** Feed startFrom / endFrom to the guide as they are, skipping the template's
   *  resize to a 1536 long edge. For frames already at the output size: the
   *  round trip through 1536 moves them by a fraction of a pixel, which shows
   *  as a shimmer on every edge where new frames meet old ones. */
  nativeGuides?: boolean;
  /** Stop at the decoded frames (node 'dv') without a SaveVideo, for graphs
   *  that splice the result into something else. */
  decodeOnly?: boolean;
}

export interface Ltx25Lora {
  file: string;
  strength: number;
  trigger?: string;
  triggerPos?: 'start' | 'end';
}

export interface Ltx25IcLora extends Ltx25Lora {
  /** Reference clip, an input-folder filename / asset token for VHS_LoadVideo. */
  video: string;
  /** Guide strength, 0..1. Default 1 (every Lightricks V2V card). */
  guideStrength?: number;
}

/** Prepend / append each LoRA's trigger word unless the prompt already carries it. */
export function withTriggers(prompt: string, loras: Ltx25Lora[]): string {
  let out = prompt.trim();
  for (const l of loras) {
    if (!l.trigger || out.includes(l.trigger)) continue;
    out = l.triggerPos === 'end' ? `${out} ${l.trigger}`.trim() : `${l.trigger} ${out}`.trim();
  }
  return out;
}

export const UPSCALER = 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors';

export const NEGATIVE = 'pc game, console game, video game, cartoon, childish, ugly';
const SIGMAS_BASE = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
export const SIGMAS_REFINE = '0.85, 0.7250, 0.4219, 0.0';

export const LTX25_FPS = 24;

/** Latent grid is 32-aligned; anything else is silently rounded by the VAE. */
export const snap32 = (n: number) => Math.max(64, Math.round(n / 32) * 32);
/** Two-stage output is exactly 2x the base latent, so the final size must be
 *  64-aligned for the delivered frame to match what was asked for. */
export const snap64 = (n: number) => Math.max(128, Math.round(n / 64) * 64);

/** The size this build will actually deliver, which may differ from the request. */
export function ltx25EffectiveSize(
  width: number,
  height: number,
  mode: Ltx25Mode,
): { width: number; height: number } {
  const snap = mode === 'flf2v' ? snap32 : snap64;
  return { width: snap(width), height: snap(height) };
}

/** LTX frame counts must satisfy n % 8 === 1. */
export function snapFrames(seconds: number, fps = LTX25_FPS): number {
  const target = Math.round(seconds * fps);
  return Math.max(9, Math.round((target - 1) / 8) * 8 + 1);
}

export function ltx25Mode(p: Pick<Ltx25Params, 'startImage' | 'endImage' | 'startFrom' | 'endFrom'>): Ltx25Mode {
  const start = !!(p.startImage || p.startFrom);
  if (start && (p.endImage || p.endFrom)) return 'flf2v';
  if (start) return 'i2v';
  return 't2v';
}

export function buildLtx25Graph(p: Ltx25Params): Record<string, unknown> {
  const fps = p.fps ?? LTX25_FPS;
  const frames = p.frames && p.frames % 8 === 1 ? p.frames : snapFrames(p.seconds, fps);
  const mode = ltx25Mode(p);
  const videoCfg = p.videoCfg ?? 1;
  const audioCfg = p.audioCfg ?? 1;

  // flf2v and IC-LoRA (v2v) are single-stage at full res; t2v/i2v start at
  // half and upsample x2.
  const single = mode === 'flf2v' || !!p.icLora;
  const { width: W, height: H } = ltx25EffectiveSize(p.width, p.height, single ? 'flf2v' : mode);
  const allLoras = [...(p.icLora ? [p.icLora] : []), ...(p.loras ?? [])];
  const prompt = withTriggers(p.prompt, allLoras);
  const baseW = single ? W : W / 2;
  const baseH = single ? H : H / 2;

  const g: Record<string, unknown> = {
    // ---- loaders (all standalone in 2.5) ----
    unet: {
      class_type: 'UNETLoader',
      inputs: { unet_name: p.transformer ?? ltx25Files().transformer, weight_dtype: 'default' },
    },
    clip: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: ltx25Files().textEncoder, type: 'ltxv', device: 'default' },
    },
    vvae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().videoVae } },
    avae: { class_type: 'VAELoader', inputs: { vae_name: ltx25Files().audioVae } },

    // ---- conditioning ----
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: p.negative ?? NEGATIVE } },
    cond: {
      class_type: 'LTXVConditioning',
      inputs: { positive: ['pos', 0], negative: ['neg', 0], frame_rate: fps },
    },

    // ---- empty latents ----
    latV: {
      class_type: 'EmptyLTXVLatentVideo',
      inputs: { width: baseW, height: baseH, length: frames, batch_size: 1 },
    },
    latA: {
      class_type: 'LTXVEmptyLatentAudio',
      inputs: { frames_number: frames, frame_rate: fps, batch_size: 1, audio_vae: ['avae', 0] },
    },

    sigBase: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_BASE } },
    noise1: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed } },
  };

  // ---- reference image preprocessing ----
  // Both templates resize the longer edge to 1536 then compress before the VAE.
  const prepImage = (key: string, file: string | [string, number]) => {
    if (typeof file === 'string') g[`${key}Load`] = { class_type: 'LoadImage', inputs: { image: file } };
    else if (p.nativeGuides) {
      g[`${key}Prep`] = { class_type: 'LTXVPreprocess', inputs: { image: file, img_compression: 18 } };
      return [`${key}Prep`, 0] as [string, number];
    }
    Object.assign(g, {
      [`${key}Edge`]: {
        class_type: 'ResizeImagesByLongerEdge',
        inputs: { images: typeof file === 'string' ? [`${key}Load`, 0] : file, longer_edge: 1536 },
      },
      [`${key}Prep`]: {
        class_type: 'LTXVPreprocess',
        inputs: { image: [`${key}Edge`, 0], img_compression: 18 },
      },
    });
    return [`${key}Prep`, 0] as [string, number];
  };

  // ---- LoRA chain: IC-LoRA first (it also reports its reference downscale), then plain LoRAs ----
  let model: [string, number] = ['unet', 0];
  if (p.icLora) {
    g.icl = {
      class_type: 'LTXICLoRALoaderModelOnly',
      inputs: { model, lora_name: p.icLora.file, strength_model: p.icLora.strength },
    };
    model = ['icl', 0];
  }
  (p.loras ?? []).forEach((l, i) => {
    g[`lora${i}`] = { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: l.file, strength_model: l.strength } };
    model = [`lora${i}`, 0];
  });

  let stage1Latent: [string, number] = ['latV', 0];
  let guidePos: [string, number] = ['cond', 0];
  let guideNeg: [string, number] = ['cond', 1];
  let startPrep: [string, number] | undefined;

  if (mode === 'flf2v') {
    // Guide frame 0 with the start image and frame -1 with the end image, then
    // crop the guides back off before decode. Single pass, full resolution.
    const s = prepImage('start', p.startFrom ?? p.startImage!);
    const e = prepImage('end', p.endFrom ?? p.endImage!);
    const strength = p.guideStrength ?? 0.7;
    Object.assign(g, {
      gA: {
        class_type: 'LTXVAddGuide',
        inputs: {
          positive: ['cond', 0], negative: ['cond', 1], vae: ['vvae', 0],
          latent: ['latV', 0], image: s, frame_idx: 0, strength,
        },
      },
      gB: {
        class_type: 'LTXVAddGuide',
        inputs: {
          positive: ['gA', 0], negative: ['gA', 1], vae: ['vvae', 0],
          latent: ['gA', 2], image: e, frame_idx: -1, strength,
        },
      },
    });
    stage1Latent = ['gB', 2];
    guidePos = ['gB', 0];
    guideNeg = ['gB', 1];
  } else if (mode === 'i2v') {
    startPrep = prepImage('start', p.startFrom ?? p.startImage!);
    g.inj1 = {
      class_type: 'LTXVImgToVideoInplace',
      inputs: { vae: ['vvae', 0], image: startPrep, latent: ['latV', 0], strength: 0.7, bypass: false },
    };
    stage1Latent = ['inj1', 0];
  }

  if (p.icLora) {
    // Reference clip at exactly the latent size and length, aligned at frame 0.
    Object.assign(g, {
      icSrc: {
        class_type: 'VHS_LoadVideo',
        inputs: {
          video: p.icLora.video, force_rate: fps, custom_width: W, custom_height: H,
          frame_load_cap: frames, skip_first_frames: 0, select_every_nth: 1,
        },
      },
      icFit: { class_type: 'ImageScale', inputs: { image: ['icSrc', 0], upscale_method: 'lanczos', width: W, height: H, crop: 'center' } },
      icGuide: {
        class_type: 'LTXAddVideoICLoRAGuide',
        inputs: {
          positive: guidePos, negative: guideNeg, vae: ['vvae', 0], latent: stage1Latent,
          image: ['icFit', 0], frame_idx: 0, strength: p.icLora.guideStrength ?? 1.0,
          latent_downscale_factor: ['icl', 1],
          crop: 'disabled', use_tiled_encode: false, tile_size: 256, tile_overlap: 64,
        },
      },
    });
    stage1Latent = ['icGuide', 2];
    guidePos = ['icGuide', 0];
    guideNeg = ['icGuide', 1];
  }

  // ---- pass 1 ----
  Object.assign(g, {
    sampler1: single
      ? { class_type: 'SamplerEulerAncestral', inputs: { eta: 0, s_noise: 1 } }
      : { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler_ancestral' } },
    guide1: {
      class_type: 'LTXVDualCFGGuider',
      inputs: { model, positive: guidePos, negative: guideNeg, video_cfg: videoCfg, audio_cfg: audioCfg },
    },
    cat1: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: stage1Latent, audio_latent: ['latA', 0] } },
    s1: {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['noise1', 0], guider: ['guide1', 0], sampler: ['sampler1', 0],
        sigmas: ['sigBase', 0], latent_image: ['cat1', 0],
      },
    },
    // flf2v reads the denoised output (slot 1); the two-stage path and the
    // IC-LoRA path (as in Mirror / Reshoot / the official V2V graph) read slot 0.
    sep1: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s1', mode === 'flf2v' && !p.icLora ? 1 : 0] } },
  });

  // Latents feeding the decoder: pass 1 output for flf2v, pass 2 output otherwise.
  let finalVideo: [string, number] = ['sep1', 0];
  let finalAudio: [string, number] = ['sep1', 1];

  if (single) {
    // Strip the guide frames back off the sampled latent before decode,
    // otherwise the injected first/last frames stay baked in.
    g.crop = {
      class_type: 'LTXVCropGuides',
      inputs: { positive: guidePos, negative: guideNeg, latent: ['sep1', 0] },
    };
    finalVideo = ['crop', 2];
  }

  if (!single) {
    // ---- 2x latent upsample + refine pass at full resolution ----
    Object.assign(g, {
      upmodel: { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: UPSCALER } },
      up: {
        class_type: 'LTXVLatentUpsampler',
        inputs: { samples: ['sep1', 0], upscale_model: ['upmodel', 0], vae: ['vvae', 0] },
      },
      sigRefine: { class_type: 'ManualSigmas', inputs: { sigmas: SIGMAS_REFINE } },
      noise2: { class_type: 'RandomNoise', inputs: { noise_seed: p.seed + 1 } },
    });

    let stage2Latent: [string, number] = ['up', 0];
    if (mode === 'i2v') {
      g.inj2 = {
        class_type: 'LTXVImgToVideoInplace',
        inputs: { vae: ['vvae', 0], image: startPrep!, latent: ['up', 0], strength: 1.0, bypass: false },
      };
      stage2Latent = ['inj2', 0];
    }

    Object.assign(g, {
      guide2: {
        class_type: 'LTXVDualCFGGuider',
        inputs: {
          model, positive: ['cond', 0], negative: ['cond', 1],
          video_cfg: videoCfg, audio_cfg: audioCfg,
        },
      },
      cat2: { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: stage2Latent, audio_latent: ['sep1', 1] } },
      s2: {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
          noise: ['noise2', 0], guider: ['guide2', 0], sampler: ['sampler1', 0],
          sigmas: ['sigRefine', 0], latent_image: ['cat2', 0],
        },
      },
      sep2: { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['s2', 0] } },
    });
    finalVideo = ['sep2', 0];
    finalAudio = ['sep2', 1];
  }

  // ---- decode + mux ----
  g.dv = {
    class_type: 'VAEDecodeTiled',
    inputs: {
      samples: finalVideo, vae: ['vvae', 0],
      tile_size: 768, overlap: 64, temporal_size: 4096, temporal_overlap: single ? 64 : 32,
    },
  };
  if (p.decodeOnly) return g;
  Object.assign(g, {
    vid: {
      class_type: 'CreateVideo',
      inputs: {
        images: ['dv', 0],
        fps,
        // audio wired in below only when asked for
      },
    },
    save: {
      class_type: 'SaveVideo',
      inputs: {
        video: ['vid', 0],
        filename_prefix: p.filenamePrefix ?? 'video/OpenField_LTX25',
        format: 'auto',
        codec: 'auto',
      },
    },
  });

  if (p.withAudio) {
    Object.assign(g, {
      da: { class_type: 'LTXVAudioVAEDecode', inputs: { samples: finalAudio, audio_vae: ['avae', 0] } },
    });
    (g.vid as { inputs: Record<string, unknown> }).inputs.audio = ['da', 0];
  }

  return g;
}
